import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import {
  addCatalogProducts,
  assignCatalogPage,
  buildPageProductContext,
  catalogProductIds,
  createCatalog,
  deleteCatalog,
  getCatalogDetail,
  listCatalogs,
  removeCatalogProduct,
  resolveCatalogForChannel,
  unassignCatalogPage,
  updateCatalog,
  workspaceHasCatalogs,
} from "@/modules/catalog/service";

/**
 * PAGE CATALOGS — ONE ACTIVE CATALOG PER PAGE, RESOLVED BY TRUSTED ID.
 *
 * Page A → Catalog A → Product A. Page B → Catalog B → Product B.
 * A never answers with B's products and B never answers with A's —
 * resolved through the channel id from the message path, never through
 * the page name, never through every product in the database.
 */
const WS = "ws-cat-a";
const WS_OTHER = "ws-cat-b";
type Db = Prisma.TransactionClient;
let db: ReturnType<typeof createFakeDb>;

async function channel(over: Record<string, unknown> = {}) {
  return (await db.channel.create({
    data: { workspaceId: WS, type: "FACEBOOK", status: "CONNECTED", displayName: "Health Store", externalId: `page-${Math.random().toString(36).slice(2, 8)}`, ...over },
  } as never)) as any;
}

async function product(over: Record<string, unknown> = {}) {
  return (await db.product.create({
    data: {
      workspaceId: WS, name: `cream-${Math.random().toString(36).slice(2, 6)}`, sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      price: 100, currency: "USD", stockStatus: "IN_STOCK", stockQty: 10, ...over,
    },
  } as never)) as any;
}

beforeEach(() => {
  db = createFakeDb();
});

describe("catalog CRUD", () => {
  it("creates, lists, updates and deletes", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "Health", description: "d" })) as any;
    expect(c.name).toBe("Health");
    expect(await listCatalogs(db as Db, WS)).toHaveLength(1);
    await updateCatalog(db as Db, WS, c.id, { name: "Health 2", isActive: false });
    const listed = await listCatalogs(db as Db, WS, { isActive: false });
    expect(listed[0]).toMatchObject({ name: "Health 2", products: 0, pages: 0 });
    await deleteCatalog(db as Db, WS, c.id);
    expect(await listCatalogs(db as Db, WS)).toHaveLength(0);
  });

  it("refuses a duplicate name in the same workspace", async () => {
    await createCatalog(db as Db, WS, { name: "Same" });
    await expect(createCatalog(db as Db, WS, { name: "Same" })).rejects.toThrow(/مستخدم بالفعل/);
  });

  it("list filters by name, status, channel and sort", async () => {
    const a = (await createCatalog(db as Db, WS, { name: "Alpha" })) as any;
    await createCatalog(db as Db, WS, { name: "Beta", isActive: false });
    const ch = await channel();
    await assignCatalogPage(db as Db, WS, { catalogId: a.id, channelId: ch.id });
    expect((await listCatalogs(db as Db, WS, { q: "alp" })).map((c: any) => c.name)).toEqual(["Alpha"]);
    expect((await listCatalogs(db as Db, WS, { isActive: false })).map((c: any) => c.name)).toEqual(["Beta"]);
    expect((await listCatalogs(db as Db, WS, { channelId: ch.id })).map((c: any) => c.name)).toEqual(["Alpha"]);
    expect((await listCatalogs(db as Db, WS, { sort: "name" })).map((c: any) => c.name)).toEqual(["Alpha", "Beta"]);
  });

  it("a foreign workspace sees nothing", async () => {
    await createCatalog(db as Db, WS, { name: "Mine" });
    expect(await listCatalogs(db as Db, WS_OTHER)).toHaveLength(0);
    await expect(updateCatalog(db as Db, WS_OTHER, "whatever", { name: "x" })).rejects.toThrow();
  });
});

describe("catalog products — links, never copies", () => {
  it("adds workspace products and reports added vs skipped", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "C" })) as any;
    const p1 = await product();
    const p2 = await product();
    expect(await addCatalogProducts(db as Db, WS, c.id, [p1.id, p2.id])).toEqual({ added: 2, skipped: 0 });
    // Duplicate add: nothing new, counted as skipped.
    expect(await addCatalogProducts(db as Db, WS, c.id, [p1.id, p2.id])).toEqual({ added: 0, skipped: 2 });
  });

  it("skips products of another workspace", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "C" })) as any;
    const foreign = await product({ workspaceId: WS_OTHER });
    expect(await addCatalogProducts(db as Db, WS, c.id, [foreign.id])).toEqual({ added: 0, skipped: 1 });
    expect(await catalogProductIds(db as Db, WS, c.id)).toEqual([]);
  });

  it("removal unlinks only — the product itself survives", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "C" })) as any;
    const p = await product();
    await addCatalogProducts(db as Db, WS, c.id, [p.id]);
    await removeCatalogProduct(db as Db, WS, c.id, p.id);
    expect(await catalogProductIds(db as Db, WS, c.id)).toEqual([]);
    expect(await db.product.findUnique({ where: { id: p.id } })).not.toBeNull();
  });

  it("deleting the catalog keeps every product", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "C" })) as any;
    const p = await product();
    await addCatalogProducts(db as Db, WS, c.id, [p.id]);
    await deleteCatalog(db as Db, WS, c.id);
    expect(await db.product.findUnique({ where: { id: p.id } })).not.toBeNull();
    expect(await db.catalogProduct.count({ where: { catalogId: c.id } })).toBe(0);
  });
});

describe("page assignment — one active catalog per page", () => {
  it("assigns, switches atomically and unassigns without deleting anything", async () => {
    const a = (await createCatalog(db as Db, WS, { name: "A" })) as any;
    const b = (await createCatalog(db as Db, WS, { name: "B" })) as any;
    const ch = await channel();
    await assignCatalogPage(db as Db, WS, { catalogId: a.id, channelId: ch.id });
    // Switch: the same single row is replaced, never doubled.
    await assignCatalogPage(db as Db, WS, { catalogId: b.id, channelId: ch.id });
    expect(await db.catalogPageAssignment.count({ where: { channelId: ch.id } })).toBe(1);
    expect((await resolveCatalogForChannel(db as Db, WS, ch.id)).catalog).toMatchObject({ id: b.id });
    await unassignCatalogPage(db as Db, WS, ch.id);
    expect((await resolveCatalogForChannel(db as Db, WS, ch.id)).status).toBe("no_assignment");
    // Catalog and its products are exactly as they were.
    expect(await db.catalog.findUnique({ where: { id: b.id } })).not.toBeNull();
  });

  it("refuses an inactive catalog, a non-conversational channel and a dead link", async () => {
    const off = (await createCatalog(db as Db, WS, { name: "Off", isActive: false })) as any;
    const ch = await channel();
    await expect(assignCatalogPage(db as Db, WS, { catalogId: off.id, channelId: ch.id })).rejects.toThrow(/متوقف/);
    // WhatsApp (and every conversational channel) binds its own catalog now;
    // only modeling-only channel types stay out (TIKTOK local adapter).
    const wa = await channel({ type: "WHATSAPP" });
    const on = (await createCatalog(db as Db, WS, { name: "On" })) as any;
    await assignCatalogPage(db as Db, WS, { catalogId: on.id, channelId: wa.id });
    expect((await resolveCatalogForChannel(db as Db, WS, wa.id)).catalog).toMatchObject({ id: on.id });
    const tt = await channel({ type: "TIKTOK" });
    await expect(assignCatalogPage(db as Db, WS, { catalogId: on.id, channelId: tt.id })).rejects.toThrow(/CHANNEL_NOT_SUPPORTED|قنوات المحادثة/);
    const dead = await channel({ status: "DISCONNECTED" });
    await expect(assignCatalogPage(db as Db, WS, { catalogId: on.id, channelId: dead.id })).rejects.toThrow(/متصلة/);
  });

  it("refuses foreign channels and catalogs", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "C" })) as any;
    const foreignCh = await channel({ workspaceId: WS_OTHER });
    await expect(assignCatalogPage(db as Db, WS, { catalogId: c.id, channelId: foreignCh.id })).rejects.toThrow();
    const foreignCat = (await createCatalog(db as Db, WS_OTHER, { name: "F" })) as any;
    const ch = await channel();
    await expect(assignCatalogPage(db as Db, WS, { catalogId: foreignCat.id, channelId: ch.id })).rejects.toThrow();
  });
});

describe("resolution — the trusted id decides, never the name", () => {
  it("no catalogs anywhere: legacy workspaces resolve nothing new", async () => {
    const ch = await channel();
    expect(await workspaceHasCatalogs(db as Db, WS)).toBe(false);
    expect(await resolveCatalogForChannel(db as Db, WS, ch.id)).toEqual({ status: "no_catalogs", catalog: null });
  });

  it("an inactive catalog is never used", async () => {
    const c = (await createCatalog(db as Db, WS, { name: "Off", isActive: false })) as any;
    // Forced straight into the table: the door refuses it, the resolver
    // must refuse it too if one ever slips past.
    const ch = await channel();
    await db.catalogPageAssignment.create({ data: { workspaceId: WS, catalogId: c.id, channelId: ch.id } } as never);
    expect(await resolveCatalogForChannel(db as Db, WS, ch.id)).toMatchObject({ status: "catalog_inactive" });
    expect(await catalogProductIds(db as Db, WS, c.id)).toEqual([]);
  });

  it("Page A answers from Catalog A only; Page B from Catalog B only", async () => {
    const prodA = await product({ name: "balsam-A" });
    const prodB = await product({ name: "phone-B" });
    const catA = (await createCatalog(db as Db, WS, { name: "Catalog A" })) as any;
    const catB = (await createCatalog(db as Db, WS, { name: "Catalog B" })) as any;
    await addCatalogProducts(db as Db, WS, catA.id, [prodA.id]);
    await addCatalogProducts(db as Db, WS, catB.id, [prodB.id]);
    // Same display name on purpose: the name must never decide.
    const pageA = await channel({ displayName: "Store", externalId: "page-a" });
    const pageB = await channel({ displayName: "Store", externalId: "page-b" });
    await assignCatalogPage(db as Db, WS, { catalogId: catA.id, channelId: pageA.id });
    await assignCatalogPage(db as Db, WS, { catalogId: catB.id, channelId: pageB.id });

    const ctxA = await buildPageProductContext(db as Db, WS, pageA.id);
    const ctxB = await buildPageProductContext(db as Db, WS, pageB.id);
    expect(ctxA.products.map((p: any) => p.id)).toEqual([prodA.id]);
    expect(ctxB.products.map((p: any) => p.id)).toEqual([prodB.id]);
    // Never leaks across: B's product is absent from A's context and back.
    expect(JSON.stringify(ctxA)).not.toContain(prodB.id);
    expect(JSON.stringify(ctxB)).not.toContain(prodA.id);
  });

  it("an unassigned page resolves nothing, even with catalogs around", async () => {
    const catA = (await createCatalog(db as Db, WS, { name: "A" })) as any;
    const prodA = await product();
    await addCatalogProducts(db as Db, WS, catA.id, [prodA.id]);
    const lone = await channel();
    const ctx = await buildPageProductContext(db as Db, WS, lone.id);
    expect(ctx).toMatchObject({ catalog: null, status: "no_assignment", products: [] });
  });

  it("an assignment of another workspace is invisible here", async () => {
    await createCatalog(db as Db, WS, { name: "Home" });
    const catB = (await createCatalog(db as Db, WS_OTHER, { name: "B" })) as any;
    const chB = await channel({ workspaceId: WS_OTHER });
    await db.catalogPageAssignment.create({ data: { workspaceId: WS_OTHER, catalogId: catB.id, channelId: chB.id } } as never);
    expect(await resolveCatalogForChannel(db as Db, WS, chB.id)).toMatchObject({ status: "no_assignment", catalog: null });
  });

  it("context carries price, images, offers and stock from Product", async () => {
    const prodA = await product({ price: 250, currency: "USD", stockQty: 7, offers: [{ title: "2x1" }] });
    const catA = (await createCatalog(db as Db, WS, { name: "A" })) as any;
    await addCatalogProducts(db as Db, WS, catA.id, [prodA.id]);
    const pageA = await channel();
    await assignCatalogPage(db as Db, WS, { catalogId: catA.id, channelId: pageA.id });
    const ctx = await buildPageProductContext(db as Db, WS, pageA.id);
    expect(ctx.products[0]).toMatchObject({ id: prodA.id, price: 250, currency: "USD", stockQty: 7, offers: [{ title: "2x1" }] });
  });

  it("an empty catalog resolves but answers nothing", async () => {
    const catA = (await createCatalog(db as Db, WS, { name: "Empty" })) as any;
    const pageA = await channel();
    await assignCatalogPage(db as Db, WS, { catalogId: catA.id, channelId: pageA.id });
    const ctx = await buildPageProductContext(db as Db, WS, pageA.id);
    expect(ctx.status).toBe("ok");
    expect(ctx.products).toEqual([]);
  });
});

describe("wiring — routes, permissions, audit, AI gate", () => {
  const src = (f: string) =>
    readFileSync(join(process.cwd(), f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("routes guard with catalogs.read, catalogs.write and catalogs.assign", () => {
    expect(src("src/app/api/catalogs/route.ts")).toContain('permission: "catalogs.read"');
    expect(src("src/app/api/catalogs/route.ts")).toContain('permission: "catalogs.write"');
    expect(src("src/app/api/catalogs/[id]/route.ts")).toContain('permission: "catalogs.write"');
    expect(src("src/app/api/catalogs/[id]/products/route.ts")).toContain('permission: "catalogs.write"');
    expect(src("src/app/api/catalogs/[id]/pages/route.ts")).toContain('permission: "catalogs.assign"');
    expect(src("src/app/api/channels/by-id/[id]/catalog/route.ts")).toContain('permission: "catalogs.read"');
  });

  it("every sensitive operation writes an audit row", () => {
    const pairs: [string, string][] = [
      ["src/app/api/catalogs/route.ts", "catalog.created"],
      ["src/app/api/catalogs/[id]/route.ts", "catalog.updated"],
      ["src/app/api/catalogs/[id]/route.ts", "catalog.deleted"],
      ["src/app/api/catalogs/[id]/products/route.ts", "catalog.products_added"],
      ["src/app/api/catalogs/[id]/products/route.ts", "catalog.product_removed"],
      ["src/app/api/catalogs/[id]/pages/route.ts", "catalog.page_assigned"],
      ["src/app/api/catalogs/[id]/pages/route.ts", "catalog.page_unassigned"],
    ];
    for (const [file, action] of pairs) {
      expect(src(file), `${file} misses ${action}`).toContain(action);
    }
  });

  it("the AI resolves products inside the page catalog, with legacy intact", () => {
    const ex = src("src/modules/ai/stages/extraction.ts");
    // The trusted resolver feeds an allow-list into the match…
    expect(ex).toContain("resolveCatalogForChannel");
    expect(ex).toMatch(/id: \{ in: allowedIds \}/);
    // …and undefined (no catalogs anywhere) keeps the legacy behaviour.
    expect(ex).toContain("allowedIds?: string[] | null");
  });

  it("prices are never copied into catalog tables", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const catalogBlock = schema.slice(schema.indexOf("model Catalog {"), schema.indexOf("model CatalogProduct {"));
    const linkBlock = schema.slice(schema.indexOf("model CatalogProduct {"), schema.indexOf("model CatalogPageAssignment {"));
    expect(catalogBlock + linkBlock).not.toMatch(/price/i);
  });
});
