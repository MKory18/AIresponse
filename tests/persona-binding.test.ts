/**
 * Persona binding: a blank model reaches the provider's own default, a new
 * persona does not silently become the workspace voice, and a live edit is
 * versioned like every other change to a persona.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const WS = "ws-persona-binding";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const instance = createFakeDb();
  return { prisma: instance, default: instance };
});

vi.mock("@/modules/auth/context", () => ({
  getAuthContext: async () => ({
    userId: "agent-binding",
    workspaceId: WS,
    role: "OWNER",
    memberPermissions: [],
    require: vi.fn(),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { prisma as db } from "@/core/db/prisma";
import { DEFAULT_MODELS, getWorkspaceProvider, logUsage, resolveModel } from "@/modules/ai/router";
import { encryptSecret } from "@/core/crypto";
import { POST, PATCH } from "@/app/api/personas/route";

const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const store of Object.values((db as any)._stores)) (store as unknown[]).length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

const blank = {
  classificationModel: null,
  extractionModel: null,
  responseModel: null,
  visionModel: null,
  summaryModel: null,
  temperature: 0.4,
  maxTokens: 500,
};

function captureModels() {
  const models: unknown[] = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    models.push(JSON.parse(String(init?.body)).model);
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as typeof fetch;
  return models;
}

const hermesEnv = { hermesBaseUrl: "http://hermes.test:8642", hermesKey: "k", hermesModel: "hermes-prod" };

async function send(settings: Record<string, unknown>, env: Record<string, string>, task: "EXTRACTION" | "RESPONSE") {
  const models = captureModels();
  const provider = getWorkspaceProvider(settings as never, env as never);
  const cfg = resolveModel(settings as never, task);
  await provider.generateText({ system: "s", user: "u", model: cfg.model });
  return models[0];
}

describe("i. a blank model falls through to the provider's default", () => {
  it.each(["RESPONSE", "EXTRACTION"] as const)("Hermes, %s, nothing set: HERMES_MODEL", async (task) => {
    expect(await send({ ...blank, provider: "hermes" }, hermesEnv, task)).toBe("hermes-prod");
  });

  it("Hermes with blank strings behaves like null", async () => {
    const settings = { ...blank, provider: "hermes", responseModel: "   ", extractionModel: "" };
    expect(await send(settings, hermesEnv, "RESPONSE")).toBe("hermes-prod");
    expect(await send(settings, hermesEnv, "EXTRACTION")).toBe("hermes-prod");
  });

  it("Hermes with no model anywhere uses its built-in name", async () => {
    expect(await send({ ...blank, provider: "hermes" }, { hermesBaseUrl: "http://h.test", hermesKey: "k" }, "RESPONSE")).toBe("hermes-agent");
  });

  it("Hermes selected by AI_PROVIDER, not the workspace, behaves the same", async () => {
    vi.stubEnv("AI_PROVIDER", "hermes");
    expect(await send({ ...blank, provider: null }, { ...hermesEnv, aiProvider: "hermes" }, "RESPONSE")).toBe("hermes-prod");
  });

  it("a blank extraction model on a custom provider uses its response model", async () => {
    const settings = {
      ...blank,
      provider: "custom",
      responseModel: "my-gateway-model",
      customBaseUrl: "http://gw.test",
      customApiKeyEnc: encryptSecret("k"),
    };
    expect(await send(settings, {}, "EXTRACTION")).toBe("my-gateway-model");
  });

  it("an explicit model still wins on Hermes", async () => {
    const settings = { ...blank, provider: "hermes", responseModel: "chosen", extractionModel: "cheap" };
    expect(await send(settings, hermesEnv, "EXTRACTION")).toBe("cheap");
  });

  it("the task env override still wins on Hermes", async () => {
    vi.stubEnv("EXTRACTION_MODEL", "env-extract");
    expect(await send({ ...blank, provider: "hermes" }, hermesEnv, "EXTRACTION")).toBe("env-extract");
  });

  it("OpenAI keeps the task defaults", () => {
    expect(resolveModel({ ...blank, provider: "openai" } as never, "RESPONSE").model).toBe(DEFAULT_MODELS.RESPONSE);
    expect(resolveModel({ ...blank, provider: "openai" } as never, "EXTRACTION").model).toBe(DEFAULT_MODELS.EXTRACTION);
    expect(resolveModel(null, "RESPONSE").model).toBe(DEFAULT_MODELS.RESPONSE);
  });

  it("embedding tasks keep their model on Hermes", () => {
    expect(resolveModel({ ...blank, provider: "hermes" } as never, "EMBEDDING").model).toBe(DEFAULT_MODELS.EMBEDDING);
  });

  it("a blank model is logged as the provider's default, never as an empty name", async () => {
    await logUsage(db, { workspaceId: WS, purpose: "RESPONSE", provider: "hermes", model: "", promptTokens: 0, completionTokens: 0, latencyMs: 0, success: true });
    expect((db as any)._stores.aIUsageLog[0].model).toBe("hermes:default");
  });
});

function request(method: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/personas", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CUID = (s: string) => `ck${s.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(20, "0").slice(0, 20)}`;

async function seed(id: string, over: Record<string, unknown> = {}) {
  return (await (db as any).persona.create({
    data: {
      id: CUID(id), workspaceId: WS, name: "الأساسية", language: "ar", tone: "friendly", formality: "informal",
      responseLength: "short", emojiLevel: 1, salesStyle: "helpful", systemInstructions: "تعليمات", isActive: true, version: 1, ...over,
    },
  })) as { id: string };
}

const active = () => ((db as any)._stores.persona as Array<{ id: string; isActive: boolean }>).filter((p) => p.isActive).map((p) => p.id);
const versions = () => (db as any)._stores.personaVersion as Array<Record<string, any>>;

describe("ii. creating a persona does not take over the workspace default", () => {
  it("the UI's body (no isActive) leaves the current default alone", async () => {
    const current = await seed("current");
    const res = await POST(request("POST", { name: "شخصية جديدة" }));
    expect(res.status).toBe(201);
    expect((await res.json()).isActive).toBe(false);
    expect(active()).toEqual([current.id]);
  });

  it("the first persona of a workspace becomes the default", async () => {
    const res = await POST(request("POST", { name: "أول شخصية" }));
    expect((await res.json()).isActive).toBe(true);
    expect(active()).toHaveLength(1);
  });

  it("an explicit isActive: true takes over", async () => {
    await seed("current");
    const body = await (await POST(request("POST", { name: "شخصية جديدة", isActive: true }))).json();
    expect(body.isActive).toBe(true);
    expect(active()).toEqual([body.id]);
  });

  it("an explicit isActive: false stays off even as the first persona", async () => {
    const body = await (await POST(request("POST", { name: "شخصية جديدة", isActive: false }))).json();
    expect(body.isActive).toBe(false);
    expect(active()).toEqual([]);
  });

  it("a failed create rolls the switch back", async () => {
    const current = await seed("current");
    const model = (db as any).persona;
    const baseCreate = model.create;
    const baseTx = (db as any).$transaction;
    const snapshot = active();
    (db as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = JSON.parse(JSON.stringify((db as any)._stores.persona));
      try {
        return await baseTx(fn);
      } catch (err) {
        (db as any)._stores.persona.length = 0;
        (db as any)._stores.persona.push(...before);
        throw err;
      }
    };
    model.create = async () => {
      throw new Error("create failed");
    };
    try {
      const res = await POST(request("POST", { name: "شخصية جديدة", isActive: true }));
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      model.create = baseCreate;
      (db as any).$transaction = baseTx;
    }
    expect(active()).toEqual(snapshot);
    expect(active()).toEqual([current.id]);
  });
});

describe("iii. a live edit is versioned", () => {
  it("a content change bumps the version and keeps a published snapshot", async () => {
    const p = await seed("edit");
    const res = await PATCH(request("PATCH", { id: p.id, systemInstructions: "تعليمات جديدة" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.systemInstructions).toBe("تعليمات جديدة");
    expect(versions()).toHaveLength(1);
    expect(versions()[0]).toMatchObject({ personaId: p.id, version: 2, status: "PUBLISHED", systemInstructions: "تعليمات جديدة", createdBy: "agent-binding" });
  });

  it("two edits make two versions", async () => {
    const p = await seed("edit");
    await PATCH(request("PATCH", { id: p.id, tone: "formal" }));
    const body = await (await PATCH(request("PATCH", { id: p.id, tone: "casual" }))).json();
    expect(body.version).toBe(3);
    expect(versions().map((v) => v.version)).toEqual([2, 3]);
  });

  it("the version skips past existing drafts", async () => {
    const p = await seed("edit");
    await (db as any).personaVersion.create({ data: { workspaceId: WS, personaId: p.id, version: 7, name: "مسودة", status: "DRAFT" } });
    const body = await (await PATCH(request("PATCH", { id: p.id, tone: "formal" }))).json();
    expect(body.version).toBe(8);
    expect(versions().map((v) => v.version).sort()).toEqual([7, 8]);
  });

  it("switching the default alone is not a content change", async () => {
    const p = await seed("edit", { isActive: false });
    const other = await seed("other");
    const body = await (await PATCH(request("PATCH", { id: p.id, isActive: true }))).json();
    expect(body.version).toBe(1);
    expect(versions()).toHaveLength(0);
    expect(active()).toEqual([p.id]);
    expect(active()).not.toContain(other.id);
  });

  it("saving identical values creates no version", async () => {
    const p = await seed("edit");
    const body = await (await PATCH(request("PATCH", { id: p.id, tone: "friendly", systemInstructions: "تعليمات" }))).json();
    expect(body.version).toBe(1);
    expect(versions()).toHaveLength(0);
  });

  it("another workspace's persona is still not found", async () => {
    const p = await seed("foreign", { workspaceId: "ws-other" });
    const res = await PATCH(request("PATCH", { id: p.id, tone: "formal" }));
    expect(res.status).toBe(404);
    expect(versions()).toHaveLength(0);
  });

  it("the edit is audited with its version", async () => {
    const p = await seed("edit");
    await PATCH(request("PATCH", { id: p.id, tone: "formal" }));
    const audit = ((db as any)._stores.auditLog as Array<Record<string, any>>).find((a) => a.action === "persona.updated");
    expect(audit?.metadata).toMatchObject({ version: 2 });
  });
});
