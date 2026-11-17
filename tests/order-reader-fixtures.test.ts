/**
 * الحزمة 0.4 — محادثات مرجعية (كل ملف `.json` إله `.expected.json` بإيد إنسان): المدقّق على خرج
 * الموديل المسجّل لازم يطلع بالقراءة الصح. + تبديل الأرقام والأسماء قبل أي تصدير.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { orderReadingSchema } from "@/modules/orders/reader/schema";
import { buildTranscript } from "@/modules/orders/reader/transcript";
import { verifyReading, type CatalogProduct } from "@/modules/orders/reader/verify";
import { anonymizeConversation, assertAnonymized, fakePhone } from "@/modules/orders/reader/fixture-export";
import { normalizePhone } from "@/modules/orders/primitives";

const DIR = "tests/fixtures/conversations";
const PRODUCTS: CatalogProduct[] = [
  { id: "p-hareer", name: "كريم حرير", sku: "HRR-1", price: 20, currency: "USD" },
  { id: "p-kamaa", name: "ماء الكمأ", sku: "KMA-1", price: 15, currency: "USD" },
  { id: "p-cap", name: "طاقية إنبات الشعر", sku: "CAP-1", price: 30, currency: "USD" },
];

const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"));
const withExpected = files.filter((f) => files.length && readdirSync(DIR).includes(f.replace(/\.json$/, ".expected.json")));

describe("المحادثات المرجعية", () => {
  it("في 8 محادثات مرجعية على الأقل، وكل واحدة إلها expected", () => {
    expect(withExpected.length).toBeGreaterThanOrEqual(8);
  });

  it.each(withExpected)("%s ← القراءة المتحقَّق منها بتطابق expected", (file) => {
    const fx = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
    const expected = JSON.parse(readFileSync(`${DIR}/${file.replace(/\.json$/, ".expected.json")}`, "utf8"));
    const t = buildTranscript(fx.messages);
    const v = verifyReading(orderReadingSchema.parse(fx.modelOutput), {
      messages: t.messages,
      market: fx.market,
      products: PRODUCTS,
      required: ["product", "quantity", "phone", "address"],
    });
    expect(v.stage).toBe(expected.stage);
    expect(v.recipient.phone).toBe(expected.phone);
    expect(v.recipient.province).toBe(expected.province);
    expect(v.items.map((i) => ({ name: i.name, quantity: i.quantity }))).toEqual(expected.items);
    expect([...v.flags].sort()).toEqual([...expected.flags].sort());
    if (expected.missing) expect([...v.missing].sort()).toEqual([...expected.missing].sort());
    if (expected.cancelRequested !== undefined) expect(v.cancelRequested).toBe(expected.cancelRequested);
  });

  it("ولا محادثة مرجعية فيها رقم هاتف حقيقي الشكل خارج الأرقام الوهمية المعروفة", () => {
    const fake = new Set(["0933111222", "0944555666", "0955666777", "0791234567", "0964123348"]);
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json") && !x.endsWith(".expected.json"))) {
      const text = readFileSync(`${DIR}/${f}`, "utf8");
      for (const m of text.matchAll(/(?<!\d)0[79]\d{8}(?!\d)/g)) expect(fake.has(m[0]), `${f}: ${m[0]}`).toBe(true);
    }
  });
});

describe("تبديل الأرقام والأسماء قبل التصدير (export-conversation-fixture)", () => {
  const sample = [
    { id: "msg-1", senderType: "CUSTOMER" as const, type: "TEXT", text: "أنا أحمد الخطيب رقمي 0933 456 789", createdAt: "2026-11-10T10:00:00Z" },
    { id: "msg-2", senderType: "AI" as const, type: "TEXT", text: "أهلا أحمد، رح نتواصل على 0933456789", createdAt: "2026-11-10T10:00:30Z" },
    { id: "msg-3", senderType: "CUSTOMER" as const, type: "TEXT", text: "أو ٠٩٤٤٥٥٥٦٦٦ وأنا بالأردن 00962791234567", createdAt: "2026-11-10T10:01:00Z" },
    { id: "msg-4", senderType: "HUMAN" as const, type: "TEXT", text: "معك سارة من الدعم", createdAt: "2026-11-10T10:02:00Z" },
  ];

  it("كل رقم بصيغته بيتبدّل برقم وهمي بنفس الطول، والرقم المكرّر بيضل نفسه", () => {
    const r = anonymizeConversation(sample, ["أحمد الخطيب", "أحمد", "سارة"]);
    const all = r.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain("0933");
    expect(all).not.toContain("٠٩٤٤٥٥٥٦٦٦");
    expect(all).not.toContain("أحمد");
    expect(all).not.toContain("سارة");
    const realPhones = r.phones.map((p) => p.real);
    expect(realPhones).toContain("0933456789");
    for (const p of r.phones) expect(p.fake.length).toBe(p.real.length);
    const fake1 = r.phones.find((p) => p.real === "0933456789")!.fake;
    expect(r.messages[0].text).toContain(fake1.slice(0, 4)); // نفس الرقم بالرسالتين
    expect(r.messages[1].text).toContain(fake1);
    // الرقم الهندي بيضل هندي
    expect(/[٠-٩]{10}/.test(r.messages[2].text!)).toBe(true);
    expect(() => assertAnonymized(JSON.stringify(r.messages), realPhones, ["أحمد الخطيب", "أحمد", "سارة"])).not.toThrow();
  });

  it("الرقم الوهمي بيضل صالح للسوق (سوري 09… · أردني 07[789]…) ومش نفس الأصلي", () => {
    const sy = fakePhone("0933456789");
    const jo = fakePhone("0791234567");
    expect(normalizePhone(sy, "SY").valid).toBe(true);
    expect(normalizePhone(jo, "JO").valid).toBe(true);
    expect(sy).not.toBe("0933456789");
    expect(jo).not.toBe("0791234567");
    expect(fakePhone("0933456789")).toBe(sy); // ثابت
  });

  it("assertAnonymized بيفشل لو باقي رقم أو اسم أصلي (السكربت ما بيكتب وقتها)", () => {
    expect(() => assertAnonymized("رقمي 0933 456 789", ["0933456789"], [])).toThrow(/FIXTURE_LEAK/);
    expect(() => assertAnonymized("أنا أحمد", [], ["أحمد"])).toThrow(/FIXTURE_LEAK/);
  });

  it("السكربت بيستدعي التبديل والفحص قبل الكتابة، وقراءة فقط من القاعدة", () => {
    const s = readFileSync("scripts/export-conversation-fixture.ts", "utf8");
    expect(s.indexOf("assertAnonymized(")).toBeLessThan(s.indexOf("writeFileSync("));
    expect(s).not.toMatch(/prisma\.\w+\.(create|update|delete|upsert)/);
  });
});
