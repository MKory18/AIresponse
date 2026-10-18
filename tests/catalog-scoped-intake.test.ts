import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "./helpers/inmemory-db";
import { updateDraftFromExtraction } from "@/modules/orders/draft-service";
import { handleOrderIntent, listResolvableProducts } from "@/modules/orders/intelligence";
import { createProduct } from "@/modules/products/service";

const WS_A = "ws-a";
const AGENT = { userId: "agent-1", workspaceId: WS_A };
type Db = Prisma.TransactionClient;

let db: ReturnType<typeof createFakeDb>;
let productIdA: string;
let productIdB: string;

async function seedWorld() {
  db = createFakeDb();
  const productA = await createProduct(db as Db, AGENT, {
    name: "ماء الكمأة", sku: "TW-500", price: 150000, currency: "SYP",
  });
  productIdA = productA.id;
  const productB = await createProduct(db as Db, AGENT, {
    name: "زيت الزيتون", sku: "OL-100", price: 90000, currency: "SYP",
  });
  productIdB = productB.id;
}

beforeEach(seedWorld);

describe("page catalogs gate ORDER intake too", () => {
  it("a product outside the assigned catalog never enters the draft", async () => {
    // Workspace catalogs exist: the page answers ONLY with its assigned catalog.
    await db.catalog.create({ data: { workspaceId: WS_A, name: "كاتالوج الصفحة", isActive: true } } as never);
    const catalog = (await db.catalog.findFirst({ where: { workspaceId: WS_A } }))! as never as { id: string };
    await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: productIdA } } as never);

    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId: "conv-1", customerId: "cust-1",
      extraction: { productName: "زيت الزيتون", quantity: 2 },
      source: "TEST",
      // Assignment resolved → only catalog products may be ordered here.
      allowedProductIds: [productIdA],
    });
    expect(result.draft.productId).toBeNull();
    expect(result.missingFields).toContain("product");
    expect(result.missingFields).not.toContain("quantity"); // quantity merged fine
  });

  it("an empty allowlist blocks every product intake", async () => {
    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId: "conv-2", customerId: "cust-2",
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
      allowedProductIds: [],
    });
    expect(result.draft.productId).toBeNull();
  });

  it("a catalog product resolves normally through the allowlist", async () => {
    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId: "conv-3", customerId: "cust-3",
      extraction: { productName: "ماء الكمأة", quantity: 1 },
      source: "TEST",
      allowedProductIds: [productIdA, productIdB],
    });
    expect(result.draft.productId).toBe(productIdA);
  });

  it("an AI-provided productId outside the catalog is ignored", async () => {
    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId: "conv-4", customerId: "cust-4",
      extraction: { productId: productIdB, quantity: 1 },
      source: "TEST",
      allowedProductIds: [productIdA],
    });
    expect(result.draft.productId).toBeNull();
  });

  it("workspace without catalogs keeps the legacy open behaviour", async () => {
    const result = await updateDraftFromExtraction(db as Db, {
      workspaceId: WS_A, conversationId: "conv-5", customerId: "cust-5",
      extraction: { productName: "زيت الزيتون", quantity: 1 },
      source: "TEST",
      // undefined → legacy behaviour: any active product may be ordered.
      allowedProductIds: undefined,
    });
    expect(result.draft.productId).toBe(productIdB);
  });

  it("listResolvableProducts honours the allowlist", async () => {
    const all = await listResolvableProducts(db as Db, WS_A);
    expect(all).toHaveLength(2);
    const scoped = await listResolvableProducts(db as Db, WS_A, [productIdA]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(productIdA);
  });

  it("handleOrderIntent accepts the allowlist and gates the draft", async () => {
    const customer = await db.customer.create({
      data: { workspaceId: WS_A, name: "زبون", phone: "0931111222", status: "INTERESTED" },
    } as never);
    await db.catalog.create({ data: { workspaceId: WS_A, name: "كاتالوج الصفحة", isActive: true } } as never);
    const catalog = (await db.catalog.findFirst({ where: { workspaceId: WS_A } }))! as never as { id: string };
    await db.catalogProduct.create({ data: { catalogId: catalog.id, productId: productIdA } } as never);

    const result = await handleOrderIntent(db as Db, {
      workspaceId: WS_A, conversationId: "conv-6", customerId: customer.id,
      extraction: {
        intent: "ORDER_CREATE", confidence: 0.95, language: "ar",
        entities: { product: "زيت الزيتون", quantity: 2 },
        missingFields: [], memories: [], requestedAction: "CREATE_ORDER",
      },
      customerText: "بدي زيت زيتون 2",
      // The reply path passes the page's catalog resolution down so an
      // off-catalog product never sneaks into an order.
      allowedProductIds: [productIdA],
    });
    expect(result.handled).toBe(true);
    expect(result.missingFields).toContain("product");
    const draft = await db.orderDraft.findUniqueOrThrow({ where: { conversationId: "conv-6" } }) as never as {
      productId: string | null;
    };
    expect(draft.productId).toBeNull();
  });
});
