import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createSessionToken, verifySessionToken } from "@/modules/auth/session";
import {
  createOAuthState,
  createPagesSelectionToken,
  verifyPagesSelectionToken,
} from "@/modules/channels/facebook/oauth";

/**
 * S-03 — أنواع التوكنات (التفاصيل: docs/HANDOVER-2026-10-27.md §4.1).
 * الجلسة بتحمل `kind: "session"` ومطلوب بالتحقق؛ توكن اختيار الصفحات بمفتاح منفصل وحمولته معمّاة.
 */

const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
const SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET!);
const PAGE_TOKEN = "EAAB-PAGE-ACCESS-TOKEN-SECRET-VALUE";

describe("S-03 session kind", () => {
  it("الجلسة العادية بتنوقّع بـ kind=session وبتتحقق", async () => {
    const t = await createSessionToken({ userId: "u1", workspaceId: "w1" });
    expect(decode(t).kind).toBe("session");
    expect(await verifySessionToken(t)).toEqual({ userId: "u1", workspaceId: "w1" });
  });

  it("توكن اختيار الصفحات ككوكي جلسة ← مرفوض", async () => {
    const t = await createPagesSelectionToken("w1", "u1", [{ id: "p1", name: "صفحة", accessToken: PAGE_TOKEN }]);
    expect(await verifySessionToken(t)).toBeNull();
  });

  it("حالة OAuth ككوكي جلسة ← مرفوضة", async () => {
    expect(await verifySessionToken(await createOAuthState("w1", "u1"))).toBeNull();
  });

  it("توكن بلا kind (قديم أو مزوّر بنفس السر) ← مرفوض", async () => {
    const legacy = await new SignJWT({ userId: "u1", workspaceId: "w1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(SECRET());
    expect(await verifySessionToken(legacy)).toBeNull();
    const wrongKind = await new SignJWT({ userId: "u1", workspaceId: "w1", kind: "fb_pages" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(SECRET());
    expect(await verifySessionToken(wrongKind)).toBeNull();
  });
});

describe("S-03 توكن اختيار صفحات فيسبوك", () => {
  it("بيدور سليم، وتوكن الصفحة مش مقروء من الرابط", async () => {
    const pages = [{ id: "p1", name: "صفحة", accessToken: PAGE_TOKEN }];
    const t = await createPagesSelectionToken("w1", "u1", pages);
    const raw = Buffer.from(t.split(".")[1], "base64url").toString("utf8");
    expect(raw).not.toContain(PAGE_TOKEN);
    expect(t).not.toContain(PAGE_TOKEN);
    expect(await verifyPagesSelectionToken(t)).toEqual({ workspaceId: "w1", userId: "u1", pages });
  });

  it("جلسة عادية ما بتنفع كتوكن اختيار صفحات", async () => {
    const session = await createSessionToken({ userId: "u1", workspaceId: "w1" });
    await expect(verifyPagesSelectionToken(session)).rejects.toThrow();
  });

  it("توكن موقّع بسر الجلسة (بنفس الشكل القديم) ما بيمرّ كتوكن صفحات", async () => {
    const old = await new SignJWT({
      workspaceId: "w1",
      userId: "u1",
      kind: "fb_pages",
      pages: [{ id: "p1", name: "x", accessToken: "evil" }],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(SECRET());
    await expect(verifyPagesSelectionToken(old)).rejects.toThrow();
  });
});
