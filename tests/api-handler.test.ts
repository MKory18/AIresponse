import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { createHandler, handleError } from "@/core/api/handler";
import { AppError } from "@/core/errors";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/test");
}

describe("centralized error handler", () => {
  it("maps AppError subclasses to status codes", () => {
    const res = handleError(new AppError("boom", 409, "CONFLICT"), makeReq(), 5);
    expect(res.status).toBe(409);
  });

  it("maps ZodError to 422 with details", () => {
    const res = handleError(new z.ZodError([]), makeReq(), 5);
    expect(res.status).toBe(422);
  });

  it("never leaks internal errors", async () => {
    const res = handleError(new Error("secret-db-connection-string"), makeReq(), 5);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret-db-connection-string");
  });
});

describe("createHandler", () => {
  const handler = createHandler(
    { permission: "orders.read", body: z.object({ a: z.string() }) },
    async ({ body, auth }) => NextResponse.json({ a: body.a, ws: auth!.workspaceId })
  );

  it("requires authentication", async () => {
    const req = new NextRequest("http://localhost/api/x", {
      method: "POST",
      body: JSON.stringify({ a: "1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("enforces rate limiting", async () => {
    const rateLimited = createHandler(
      { public: true, rateLimit: { limit: 1, windowMs: 60_000 } },
      async () => NextResponse.json({ ok: true })
    );
    const req = new NextRequest("http://localhost/api/rl", { method: "POST" });
    await rateLimited(req);
    const second = await rateLimited(req);
    expect(second.status).toBe(429);
  });
});
