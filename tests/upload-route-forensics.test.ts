/**
 * FORENSIC reproduction of the REAL upload path:
 *   Browser FormData → POST /api/media/upload → validation → magic bytes →
 *   storage write → MediaAsset → ProductMedia → response
 * Uses the actual route handler with a real multipart NextRequest.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { resetEnvCache } from "@/core/env";

vi.mock("@/core/db/prisma", async () => {
  const { createFakeDb } = await import("./helpers/inmemory-db");
  const instance = createFakeDb();
  return { prisma: instance, default: instance };
});

const fakeAuth = {
  userId: "user-upload",
  workspaceId: "ws-up-a",
  require: vi.fn(),
  role: "OWNER",
};

vi.mock("@/modules/auth/context", () => ({
  getAuthContext: async () => fakeAuth,
}));

import { POST } from "@/app/api/media/upload/route";
import * as prismaModule from "@/core/db/prisma";

const WS = "ws-up-a";
type Db = Prisma.TransactionClient;
let db: Db;

function pngBytes(): Buffer {
  // Minimal structurally-valid PNG: signature + IHDR chunk with correct CRC.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const type = Buffer.from("IHDR");
  const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
  const crcInput = Buffer.concat([type, ihdrData]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  const iend = Buffer.concat([Buffer.alloc(4), Buffer.from("IEND"), Buffer.alloc(4)]);
  return Buffer.concat([sig, len, type, ihdrData, crc, iend]);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uploadRequest(file: { name: string; type: string; data: Buffer }, extra: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file.data)], file.name, { type: file.type }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new NextRequest("http://localhost:3000/api/media/upload", {
    method: "POST",
    body: form,
    headers: { origin: "http://localhost:3000", host: "localhost:3000" },
  });
}

describe("REAL upload route — exact user filename", () => {
  beforeEach(() => {
    db = prismaModule.prisma as unknown as Db;
    resetEnvCache();
  });

  it('uploads "ChatGPT Image Aug 29, 2026, 12_17_22 PM.png" (real PNG bytes, browser MIME)', async () => {
    const res = await POST(uploadRequest({
      name: "ChatGPT Image Aug 29, 2026, 12_17_22 PM.png",
      type: "image/png",
      data: pngBytes(),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("IMAGE");
    expect(body.mimeType).toBe("image/png");
    expect(body.storageKey).toContain(WS);
    expect(body.storageKey).toMatch(/\.png$/);
  });

  it("uploads the same file when the browser sends NO MIME (empty type) — server derives image/png", async () => {
    const res = await POST(uploadRequest({
      name: "ChatGPT Image Aug 29, 2026, 12_17_22 PM.png",
      type: "",
      data: pngBytes(),
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).mimeType).toBe("image/png");
  });

  it("uploads the same file when the browser sends application/octet-stream", async () => {
    const res = await POST(uploadRequest({
      name: "photo.png",
      type: "application/octet-stream",
      data: pngBytes(),
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).mimeType).toBe("image/png");
  });

  it("attaches to product: MediaAsset + ProductMedia + legacy FK all consistent", async () => {
    const product = await (db as any).product.create({
      data: { workspaceId: WS, name: "P", price: 1 },
    });
    const res = await POST(uploadRequest(
      { name: "صورة المنتج.png", type: "image/png", data: pngBytes() },
      { productId: product.id, category: "PRODUCT" }
    ));
    expect(res.status).toBe(201);
    const asset = await res.json();
    const link = (db._stores.productMedia as any[]).find((l) => l.mediaAssetId === asset.id);
    expect(link).toBeTruthy();
    expect(asset.productId).toBe(product.id);
  });

  it("Arabic + emoji + multi-dot + 200-char filenames all succeed", async () => {
    const names = [
      "صورة المنتج 01.png",
      "product 😊 final.webp",
      "my.product.final.v2.jpg",
      `${"a".repeat(190)}.png`,
      "photo_٢٠٢٦-٠٧-١٩_١٥-٣٨-٥٤.jpg",
    ];
    for (const name of names) {
      const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      const data = type === "image/png" ? pngBytes() : type === "image/jpeg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]) : Buffer.from("RIFF____WEBPVP8 ");
      const res = await POST(uploadRequest({ name, type, data }));
      expect(res.status, `failed for ${name}`).toBe(201);
    }
  });

  it("script renamed .png is rejected with CORRUPT_FILE (positive evidence)", async () => {
    const res = await POST(uploadRequest({
      name: "evil.png",
      type: "image/png",
      data: Buffer.from("<script>alert(1)</script>"),
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("CORRUPT_FILE");
  });

  it("STORAGE FAILURE returns structured JSON (not silent generic) with explicit code", async () => {
    const { getStorage } = await import("@/modules/media/storage");
    const orig = getStorage();
    vi.spyOn(orig, "put").mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    try {
      const res = await POST(uploadRequest({ name: "x.png", type: "image/png", data: pngBytes() }));
      expect(res.status).toBe(500);
      const body = await res.json();
      // The developer MUST see a structured reason — not a bare body with no message.
      expect(body.error).toBeTruthy();
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toBe("INTERNAL_ERROR");
      expect(body.message).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
