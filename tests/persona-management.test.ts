import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";

/**
 * Persona management under the external provider (OpenRouter connection):
 *  - lifecycle (create/publish/rollback/activate/channel-binding) works
 *    through the REAL routes with NO 409 blocks;
 *  - the playground uses the same selected persona;
 *  - no internal brand string is user-visible on the site.
 */

const WS_PM = "ws-persona-mgmt";
const PM_KEY = "sk-pm-openrouter-key";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const instance = createFakeDb();
  return { prisma: instance, default: instance };
});

vi.mock("@/modules/auth/context", () => ({
  getAuthContext: async () => ({
    userId: "agent-pm",
    workspaceId: WS_PM,
    role: "OWNER",
    memberPermissions: [],
    require: vi.fn(),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { prisma as db } from "@/core/db/prisma";

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CUID = (s: string) => `ck${s.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(20, "0").slice(0, 20)}`;

beforeEach(async () => {
  for (const store of Object.values((db as any)._stores)) (store as unknown[]).length = 0;
  await (db as any).aISettings.create({
    data: { workspaceId: WS_PM, provider: "openrouter", responseModel: "openai/gpt-4o-mini", temperature: 0.4, maxTokens: 500 },
  });
});

describe("persona lifecycle routes stay open under the external provider (no 409s)", () => {
  it("7. create + activate + publish + rollback + channel binding all succeed with the external provider selected", async () => {
    const { POST: createPersona } = await import("@/app/api/personas/route");
    const { PATCH: updatePersona } = await import("@/app/api/personas/route");
    const { POST: createDraft } = await import("@/app/api/personas/[id]/versions/route");
    const { POST: publish } = await import("@/app/api/personas/[id]/versions/[version]/publish/route");
    const { POST: rollback } = await import("@/app/api/personas/[id]/versions/[version]/rollback/route");
    const { PATCH: bindChannel } = await import("@/app/api/channels/by-id/[id]/persona/route");

    // Seed personas with cuid-valid ids (the PATCH schemas validate cuid).
    const p1 = CUID("pmpersonaactive01");
    await (db as any).persona.create({
      data: {
        id: p1, workspaceId: WS_PM, name: "بائع التجارب", language: "ar", dialect: null,
        tone: "friendly", formality: "informal", responseLength: "short", emojiLevel: 1, salesStyle: "helpful",
        systemInstructions: "تعليمات-UNIQUE-PM", prohibitedPhrases: [], customRules: [],
        isActive: true, version: 1,
      },
    });

    // Create (active by default) — must NOT 409.
    const created = await createPersona(
      post("/api/personas", { name: "بائع ثان", language: "ar", tone: "formal", isActive: true })
    );
    expect(created.status).toBe(201);

    // Explicit activation of the seeded persona — must NOT 409.
    const activated = await updatePersona(patch("/api/personas", { id: p1, isActive: true }));
    expect(activated.status).toBe(200);
    const persona = { id: p1 };

    // Draft → publish → rollback — must NOT 409.
    const draft = await createDraft(post(`/api/personas/${persona.id}/versions`, {}), {
      params: { id: persona.id },
    } as never);
    expect(draft.status).toBe(201);
    const version = (await draft.json()).version as number;
    const pub = await publish(post(`/api/personas/${persona.id}/versions/${version}/publish`, {}), {
      params: { id: persona.id, version: String(version) },
    } as never);
    expect(pub.status).toBe(200);
    const rb = await rollback(post(`/api/personas/${persona.id}/versions/${version}/rollback`, {}), {
      params: { id: persona.id, version: String(version) },
    } as never);
    expect(rb.status).toBe(200);

    // Channel binding — must NOT 409.
    const chId = CUID("pmchannelfb01");
    await (db as any).channel.create({
      data: { id: chId, workspaceId: WS_PM, type: "FACEBOOK", status: "CONNECTED", externalId: "page-pm" },
    });
    const bound = await bindChannel(patch(`/api/channels/by-id/${chId}/persona`, { personaId: persona.id }), {
      params: { id: chId },
    } as never);
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ aiPersonaId: persona.id });
  });
});

describe("playground uses the same selected persona (external provider)", () => {
  it("5. the selected persona's instructions reach the provider in the playground too", async () => {
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = PM_KEY;
    const calls: { url: string; body: any }[] = [];
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
      let body: any = null;
      try {
        body = JSON.parse(String((init as any)?.body ?? ""));
      } catch { /* ignore */ }
      calls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "رد تجريبي" } }], usage: {} }),
        { status: 200 }
      );
    };
    try {
      const { setMockAIProvider } = await import("@/modules/ai/provider");
      setMockAIProvider(undefined);
      const persona = (await (db as any).persona.create({
        data: {
          workspaceId: WS_PM, name: "بائع-الملعب-UNIQUE", language: "ar", dialect: "ملعب-UNIQUE",
          tone: "t", formality: "informal", responseLength: "short", emojiLevel: 1, salesStyle: "s",
          systemInstructions: "PG-MARKER-789", prohibitedPhrases: [], customRules: [],
          isActive: true, version: 2,
        },
      })) as any;
      const { createPlaygroundSession, sendPlaygroundMessage } = await import("@/modules/ai/playground-service");
      const s = (await createPlaygroundSession(
        db as never,
        { userId: "agent-pm", workspaceId: WS_PM },
        { personaId: persona.id, useKnowledge: false }
      )) as unknown as { id: string };
      const reply = await sendPlaygroundMessage(db as never, { userId: "agent-pm", workspaceId: WS_PM }, s.id, "مرحبا");
      expect(reply.response).toBe("رد تجريبي");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const systems = calls.map((c) => String(c.body?.messages?.[0]?.content ?? "")).join("\n");
      expect(systems).toContain("بائع-الملعب-UNIQUE");
      expect(systems).toContain("PG-MARKER-789");
      expect(systems).toContain("ملعب-UNIQUE");
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = orig;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
});

describe("no internal brand string in user-visible site text (static)", () => {
  const PAGES = [
    "src/app/(dashboard)/personas/page.tsx",
    "src/app/(dashboard)/channels/page.tsx",
    "src/app/(dashboard)/settings/ai/page.tsx",
    "src/app/(dashboard)/settings/ai/ai-status-card.tsx",
    "src/app/(dashboard)/ai/playground/page.tsx",
    "src/components/auth-form.tsx",
  ];
  it("8. pages render generic labels only (any provider choice is a generic one)", async () => {
    for (const f of PAGES) {
      const src = await readFile(f, "utf8");
      const visible = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1")
        .replace(/value="hermes"/g, "")
        .replace(/["']hermes["']/g, "")
        .replace(/\bhermes(?=\s*:)/g, "")
        .replace(/HERMES_[A-Z_]+/g, "")
        .replace(/hermes-agent/g, "");
      expect(visible, `${f} shows no internal brand`).not.toMatch(/hermes/i);
    }
    const aiSrc = await readFile("src/app/(dashboard)/settings/ai/page.tsx", "utf8");
    expect(aiSrc).not.toMatch(/HERMES_/);
  });
});
