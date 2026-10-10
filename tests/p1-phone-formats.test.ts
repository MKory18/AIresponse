import { describe, expect, it } from "vitest";
import type { AIProvider, AIResponse, TextRequest } from "@/modules/ai/provider";
import {
  extractPhoneDeterministic,
  findPhoneCandidates,
  scrubForEmbedding,
  sendProtectedText,
} from "@/modules/ai/privacy-gate";
import { validateResponse } from "@/modules/ai/guardrails";

/**
 * P1.1 phone-format closure. All fixtures are fake numbers.
 * Policy under test (documented in privacy-gate.ts):
 * - KNOWN profile values are masked in ANY spelling (exact, spaced, dashed,
 *   Arabic-Indic, country-prefixed).
 * - Unknown bare 7–8 runs are masked only in phone context; order/price
 *   context exempts them (documented residual: context-free bare runs of
 *   unknown numbers cannot be told apart from totals with confidence).
 * - Reply-side scrubbing is strict but honors vault + trustedContacts +
 *   allowedNumbers (prices/totals), so legit figures survive.
 */
class RecordingExternal implements AIProvider {
  readonly name = "recording-external";
  readonly delivery = "external" as const;
  wire = "";
  async generateText(req: TextRequest): Promise<AIResponse> {
    this.wire = `${req.system}\n${req.user}`;
    return { text: "للتواصل 99998888. الإجمالي 1250000.", promptTokens: 1, completionTokens: 1, latencyMs: 1 };
  }
  async generateStructured<T>(): Promise<AIResponse & { value: T }> {
    throw new Error("unused");
  }
}

describe("P1.1 required formats — known profile phone in every spelling", () => {
  const cases: Array<[string, string]> = [
    ["bare 8", "12345678"],
    ["spaced", "12 34 56 78"],
    ["country code", "+222 12 34 56 78"],
    ["arabic-indic", "١٢٣٤٥٦٧٨"],
  ];
  for (const [label, spelling] of cases) {
    it(`masks ${label} (known phone 12345678) before the external model`, async () => {
      const rec = new RecordingExternal();
      const res = await sendProtectedText(
        rec,
        { system: "أنت مساعد.", user: `رقمي هو ${spelling} تواصل معي` },
        { pii: { phone: "12345678" }, purpose: "P11" }
      );
      expect(rec.wire).not.toContain(spelling);
      expect(rec.wire).not.toContain("12345678");
      expect(res.text).not.toContain("[PII-");
    });
  }

  it("masks dashed + Indic variants of the known phone", async () => {
    const rec = new RecordingExternal();
    await sendProtectedText(
      rec,
      { system: "s", user: "اتصل على 12-34-56-78 أو ١٢-٣٤-٥٦-٧٨" },
      { pii: { phone: "12345678" }, purpose: "P11" }
    );
    expect(rec.wire).not.toContain("12-34-56-78");
    expect(rec.wire).not.toContain("١٢-٣٤-٥٦-٧٨");
  });
});

describe("P1.1 free-text unknown numbers — context discrimination", () => {
  it("masks a bare unknown number sitting in phone context", () => {
    const found = findPhoneCandidates("من فضلك كلمني على 87654321 غدا", { contextAware: true });
    expect(found.join(" ")).toContain("87654321");
  });

  it("keeps the same digits in order/price context (documented residual)", () => {
    const found = findPhoneCandidates("الإجمالي 87654321 ليرة للطلب", { contextAware: true });
    expect(found).toHaveLength(0);
  });

  it("keeps short prices and quantities everywhere", () => {
    expect(findPhoneCandidates("السعر 150000 ليرة والكمية 3", { contextAware: true })).toHaveLength(0);
    expect(findPhoneCandidates("الإجمالي 1250000", { contextAware: true })).toHaveLength(0);
  });

  it("scrubs embedding inputs in phone context, keeps context-free totals", () => {
    expect(scrubForEmbedding("كلمني 87654321")).not.toContain("87654321");
    // Safety bias: a total within ±25 chars of a phone word is masked too
    // (documented — embeddings have no restoration, and the shape is
    // indistinguishable from a phone there).
    expect(scrubForEmbedding("كلمني 87654321")).toContain("[محجوب]");
    expect(scrubForEmbedding("فاتورة الطلب: الإجمالي 1250000 ليرة")).toContain("1250000");
  });
});

describe("P1.1 reply-side strictness with allowlists", () => {
  it("redacts hallucinated bare numbers but keeps allowlisted totals", async () => {
    const rec = new RecordingExternal();
    const res = await sendProtectedText(
      rec,
      { system: "s", user: "بكم؟" },
      { pii: {}, allowedNumbers: ["1250000"], purpose: "P11" }
    );
    expect(res.text).not.toContain("99998888");
    expect(res.text).toContain("[محجوب]");
    expect(res.text).toContain("1250000");
  });

  it("guardrail rejects invented bare contacts, accepts allowlisted figures", () => {
    const bad = validateResponse({ response: "تواصل 99998888", trustedContacts: ["12345678"] });
    expect(bad.valid).toBe(false);
    expect(bad.violations).toContain("UNVERIFIED_CONTACT");
    const good = validateResponse({
      response: "الإجمالي 1250000 والرقم 12345678",
      trustedContacts: ["12345678"],
      allowedNumbers: ["1250000"],
    });
    expect(good.violations).not.toContain("UNVERIFIED_CONTACT");
  });
});

describe("P1.1 deterministic extraction across shapes (rules decide)", () => {
  it("extracts Indic + prefixed + contextual bare numbers", () => {
    expect(extractPhoneDeterministic("كلمني على ١٢٣٤٥٦٧٨ بكرا")).toBe("12345678");
    expect(extractPhoneDeterministic("رقمي +222 12 34 56 78")).toBe("22212345678");
    expect(extractPhoneDeterministic("هاتفي 87654321")).toBe("87654321");
  });

  it("still ignores prices and totals", () => {
    expect(extractPhoneDeterministic("السعر 150000 ليرة")).toBeNull();
    expect(extractPhoneDeterministic("الإجمالي 1250000 للطلب")).toBeNull();
  });
});

describe("P1.1 no cross-session mixing with new shapes", () => {
  it("variant vaults stay per-call", async () => {
    const r1 = new RecordingExternal();
    const o1 = await sendProtectedText(r1, { system: "s", user: "رقمي 12 34 56 78" }, { pii: { phone: "12345678" }, purpose: "P11" });
    const r2 = new RecordingExternal();
    const o2 = await sendProtectedText(r2, { system: "s", user: "رقمي 87 65 43 21" }, { pii: { phone: "87654321" }, purpose: "P11" });
    expect(r1.wire).not.toContain("12 34 56 78");
    expect(r2.wire).not.toContain("87 65 43 21");
    expect(o1.text).not.toContain("87654321");
    expect(o2.text).not.toContain("12345678");
  });
});
