import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { LocalStorageProvider, getStorage } from "@/modules/media/storage";
import {
  uploadMedia,
  getOwnedMedia,
  listMedia,
  updateMedia,
  deleteMedia,
} from "@/modules/media/service";
import {
  attachProductMedia,
  detachProductMedia,
  reorderProductMedia,
  setPrimaryProductMedia,
  createProduct,
} from "@/modules/products/service";
import { findProductMedia } from "@/modules/media/service";
import { trustedDataPrompt } from "@/modules/ai/prompts";
import { NotFoundError } from "@/core/errors";

const WS_A = "ws-media-a";
const WS_B = "ws-media-b";
const ctxA = { userId: "user-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;
let tmp: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
// Minimal valid headers per claimed MIME (magic-byte check requires a match).
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

beforeEach(() => {
  db = createFakeDb();
  tmp = mkdtempSync(join(tmpdir(), "acre-media-"));
  (globalThis as Record<string, unknown>).__acreStorage = new LocalStorageProvider(tmp);
  return () => {
    rmSync(tmp, { recursive: true, force: true });
  };
});

async function seedProduct() {
  return createProduct(db as Db, ctxA, { name: "منتج", sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, price: 100 });
}

describe("MEDIA e2e — upload & storage", () => {
  it("1. uploads JPG/PNG/WEBP: file persists + DB record created", async () => {
    const cases = [["a.jpg", "image/jpeg", JPG], ["b.png", "image/png", PNG], ["c.webp", "image/webp", WEBP]] as const;
    for (const [filename, mime, data] of cases) {
      const asset = (await uploadMedia(db as Db, ctxA, {
        filename, mimeType: mime, size: data.length, data: Buffer.from(data), category: "PRODUCT",
      })) as unknown as { id: string; storageKey: string; url: string; type: string };
      expect(asset.type).toBe("IMAGE");
      expect(asset.url).toContain("/api/media/file/");
      // Existence check without opening a stream (leaked streams race teardown).
      expect(existsSync(join(tmp, ...asset.storageKey.split("/")))).toBe(true);
    }
    expect((db._stores.mediaAsset as unknown[])).toHaveLength(3);
  });

  it("2. invalid MIME rejected", async () => {
    await expect(
      uploadMedia(db as Db, ctxA, { filename: "a.zip", mimeType: "application/zip", size: 10, data: Buffer.alloc(10) })
    ).rejects.toThrow();
  });

  it("3. path traversal rejected", async () => {
    const provider = new LocalStorageProvider(tmp);
    await expect(provider.put("../evil.png", PNG, "image/png")).rejects.toThrow();
    expect(await provider.get("../../etc/passwd")).toBeNull();
    expect(await provider.get(`${tmp}-evil/x`)).toBeNull();
  });

  it("4. file persists and round-trips bytes", async () => {
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "r.png", mimeType: "image/png", size: PNG.length, data: PNG,
    })) as unknown as { storageKey: string };
    const stored = await getStorage().get(asset.storageKey);
    expect(stored).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of (stored as { stream: AsyncIterable<Buffer> }).stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
  });

  it("Arabic filenames work", async () => {
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "صورة منتج.jpg", mimeType: "image/jpeg", size: JPG.length, data: Buffer.from(JPG),
    })) as unknown as { storageKey: string; title: string | null };
    expect(asset.storageKey).toContain("صورة منتج");
    expect(existsSync(join(tmp, ...asset.storageKey.split("/")))).toBe(true);
  });

  it("duplicate filename never overwrites", async () => {
    const a = (await uploadMedia(db as Db, ctxA, { filename: "d.png", mimeType: "image/png", size: PNG.length, data: PNG })) as unknown as { storageKey: string };
    const b = (await uploadMedia(db as Db, ctxA, { filename: "d.png", mimeType: "image/png", size: PNG.length, data: PNG })) as unknown as { storageKey: string };
    expect(a.storageKey).not.toBe(b.storageKey);
  });

  it("9. workspace isolation on read/list", async () => {
    const asset = (await uploadMedia(db as Db, ctxA, { filename: "w.png", mimeType: "image/png", size: PNG.length, data: PNG })) as unknown as { id: string };
    await expect(getOwnedMedia(db as Db, WS_B, asset.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMedia(db as Db, { workspaceId: WS_B })).items).toHaveLength(0);
    expect((await listMedia(db as Db, { workspaceId: WS_A })).items).toHaveLength(1);
  });
});

describe("MEDIA e2e — product linking", () => {
  it("6. attach persists (join + legacy FK) and survives re-read", async () => {
    const product = await seedProduct();
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "p.png", mimeType: "image/png", size: PNG.length, data: PNG, productId: (product as { id: string }).id,
    })) as unknown as { id: string };
    const found = await findProductMedia(db as Db, WS_A, (product as { id: string }).id);
    expect(found.map((m) => m.id)).toContain(asset.id);
  });

  it("PATCH productId re-points the join row (no desync)", async () => {
    const p1 = (await seedProduct()) as unknown as { id: string };
    const p2 = (await seedProduct()) as unknown as { id: string };
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "m.png", mimeType: "image/png", size: PNG.length, data: PNG, productId: p1.id,
    })) as unknown as { id: string };
    await updateMedia(db as Db, ctxA, asset.id, { productId: p2.id });
    expect((await findProductMedia(db as Db, WS_A, p1.id)).map((m) => m.id)).not.toContain(asset.id);
    expect((await findProductMedia(db as Db, WS_A, p2.id)).map((m) => m.id)).toContain(asset.id);
  });

  it("7. detach keeps the original asset", async () => {
    const product = (await seedProduct()) as unknown as { id: string };
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "k.png", mimeType: "image/png", size: PNG.length, data: PNG, productId: product.id,
    })) as unknown as { id: string };
    await detachProductMedia(db as Db, ctxA, product.id, asset.id);
    expect((await findProductMedia(db as Db, WS_A, product.id))).toHaveLength(0);
    expect(await getOwnedMedia(db as Db, WS_A, asset.id)).toBeTruthy();
  });

  it("8. delete asset cleans storage + DB rows", async () => {
    const product = (await seedProduct()) as unknown as { id: string };
    const asset = (await uploadMedia(db as Db, ctxA, {
      filename: "del.png", mimeType: "image/png", size: PNG.length, data: PNG, productId: product.id,
    })) as unknown as { id: string; storageKey: string };
    await deleteMedia(db as Db, ctxA, asset.id);
    await expect(getOwnedMedia(db as Db, WS_A, asset.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getStorage().get(asset.storageKey)).toBeNull();
  });

  it("reorder + primary persist", async () => {
    const product = (await seedProduct()) as unknown as { id: string };
    const ids: string[] = [];
    for (const n of ["1.png", "2.png", "3.png"]) {
      const a = (await uploadMedia(db as Db, ctxA, { filename: n, mimeType: "image/png", size: PNG.length, data: PNG })) as unknown as { id: string };
      ids.push(a.id);
      await attachProductMedia(db as Db, ctxA, product.id, a.id);
    }
    await setPrimaryProductMedia(db as Db, ctxA, product.id, ids[2]);
    await reorderProductMedia(db as Db, ctxA, product.id, [ids[2], ids[0], ids[1]]);
    const rows = (db._stores.productMedia as Array<{ mediaAssetId: string; sortOrder: number; isPrimary: boolean }>)
      .filter((l) => l.productId === product.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(rows.map((r) => r.mediaAssetId)).toEqual([ids[2], ids[0], ids[1]]);
    expect(rows.find((r) => r.mediaAssetId === ids[2])!.isPrimary).toBe(true);
  });
});

describe("MEDIA — AI prompt wiring", () => {
  it("linked images enter the trusted prompt; absent media renders nothing", () => {
    const withMedia = trustedDataPrompt({
      product: {
        name: "ماء الكمأة", price: "150000", currency: "SYP", stockStatus: "IN_STOCK",
        shortDescription: null, benefits: [], usage: null, warnings: null, objections: [], salesNotes: null, faqs: [],
      },
      media: [{ title: "صورة المنتج", url: "/api/media/file/ws/a.png" }],
    });
    expect(withMedia).toContain("/api/media/file/ws/a.png");
    expect(withMedia).toContain("صورة المنتج");
    const without = trustedDataPrompt({ knowledge: { faqs: [], documents: [] } });
    expect(without).not.toContain("صور المنتج");
  });
});
