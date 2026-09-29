import type { Prisma, ChannelType, CustomerStatus } from "@prisma/client";
import { AppError, ConflictError, NotFoundError } from "@/core/errors";
import { makeEvent, eventBus } from "@/core/events/bus";
import { recordAudit } from "@/modules/audit/service";

export type Db = Prisma.TransactionClient;

export interface ActorContext {
  userId: string;
  workspaceId: string;
  ip?: string;
}

// â”€â”€ Channel identity resolution (no cross-channel identity assumptions) â”€â”€â”€â”€

export async function resolveCustomerByChannelIdentity(
  db: Db,
  input: {
    workspaceId: string;
    channelType: ChannelType;
    externalUserId: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<{ customerId: string; created: boolean }> {
  const identity = await db.channelIdentity.findUnique({
    where: {
      channelType_channelExternalId: {
        channelType: input.channelType,
        channelExternalId: input.externalUserId,
      },
    },
  });

  if (identity) {
    // Identity exists — ensure it belongs to this workspace (identity ids are
    // globally unique per channel, so a mismatch would indicate data drift).
    if (identity.workspaceId !== input.workspaceId) {
      throw new AppError("Channel identity belongs to another workspace", 409, "IDENTITY_CONFLICT");
    }
    // Facebook is the source of truth for name/avatar: persist the latest
    // profile values on every inbound (refresh policy), so a customer who
    // changes their FB name/picture converges on next message. Never overwrite
    // real values with null — only with newer non-null values.
    const existingDisplay = (identity as { displayName?: string | null }).displayName ?? null;
    const existingAvatar = (identity as { avatarUrl?: string | null }).avatarUrl ?? null;
    const updates: Record<string, string> = {};
    if (input.displayName && input.displayName !== existingDisplay) {
      updates.displayName = input.displayName;
    }
    if (input.avatarUrl && input.avatarUrl !== existingAvatar) {
      updates.avatarUrl = input.avatarUrl;
    }
    if (Object.keys(updates).length > 0) {
      await db.channelIdentity.update({ where: { id: identity.id }, data: updates });
    }
    if (input.displayName || input.avatarUrl) {
      const customer = await db.customer.findUnique({
        where: { id: identity.customerId },
        select: { id: true, name: true, avatarUrl: true },
      });
      if (customer) {
        const customerUpdates: Record<string, string> = {};
        if (input.displayName && input.displayName !== (customer.name ?? null)) customerUpdates.name = input.displayName;
        if (input.avatarUrl && input.avatarUrl !== ((customer as { avatarUrl?: string | null }).avatarUrl ?? null)) {
          customerUpdates.avatarUrl = input.avatarUrl;
        }
        if (Object.keys(customerUpdates).length > 0) {
          await db.customer.update({ where: { id: customer.id }, data: customerUpdates });
        }
      }
    }
    return { customerId: identity.customerId, created: false };
  }

  try {
    const customer = await db.customer.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        status: "NEW_LEAD",
        lastContactAt: new Date(),
        identities: {
          create: {
            workspaceId: input.workspaceId,
            channelType: input.channelType,
            channelExternalId: input.externalUserId,
            displayName: input.displayName ?? null,
            avatarUrl: input.avatarUrl ?? null,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          },
        },
      },
    });

    await eventBus.publish(
      makeEvent("CustomerCreated", input.workspaceId, {
        customerId: customer.id,
        channelType: input.channelType,
        externalUserId: input.externalUserId,
      })
    );

    return { customerId: customer.id, created: true };
  } catch (err) {
    // Concurrent first-message race: two webhooks for a new PSID both saw
    // findUnique=null and both tried create — the unique constraint winner
    // owns the row; re-read and treat as existing (never 500 the webhook).
    if ((err as { code?: string }).code === "P2002") {
      const winner = await db.channelIdentity.findUnique({
        where: {
          channelType_channelExternalId: {
            channelType: input.channelType,
            channelExternalId: input.externalUserId,
          },
        },
      });
      if (winner) return { customerId: winner.customerId, created: false };
    }
    throw err;
  }
}

// â”€â”€ Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildCustomerSearchWhere(workspaceId: string, q?: string) {
  const base: Prisma.CustomerWhereInput = { workspaceId };
  if (!q) return base;
  return {
    ...base,
    OR: [
      { name: { contains: q, mode: "insensitive" as const } },
      { phone: { contains: q } },
      { email: { contains: q, mode: "insensitive" as const } },
    ],
  };
}

export async function listCustomers(
  db: Db,
  params: { workspaceId: string; q?: string; cursor?: string; limit?: number }
): Promise<Paginated<Prisma.CustomerGetPayload<{ include: { identities: true } }>>> {
  const limit = Math.min(params.limit ?? 25, 100);
  const where = buildCustomerSearchWhere(params.workspaceId, params.q);

  const customers = await db.customer.findMany({
    where,
    include: { identities: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = customers.length > limit;
  const items = hasMore ? customers.slice(0, limit) : customers;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

// â”€â”€ Detail / update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getOwnedCustomer(db: Db, workspaceId: string, customerId: string) {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: { identities: true },
  });
  if (!customer || customer.workspaceId !== workspaceId) {
    // NotFound (not 403) to avoid leaking cross-workspace existence.
    throw new NotFoundError("Customer");
  }
  return customer;
}

export async function getCustomerDetail(db: Db, ctx: ActorContext, customerId: string) {
  const customer = await getOwnedCustomer(db, ctx.workspaceId, customerId);
  const [orders, conversations] = await Promise.all([
    db.order.findMany({
      where: { workspaceId: ctx.workspaceId, customerId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, orderNumber: true, status: true, total: true, currency: true, createdAt: true },
    }),
    db.conversation.findMany({
      where: { workspaceId: ctx.workspaceId, customerId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, status: true, aiState: true, summary: true, updatedAt: true },
    }),
  ]);
  return { ...customer, orders, conversations, aiSummary: customer.notes ?? null };
}

const MAX_TAGS = 30;

export async function updateCustomer(
  db: Db,
  ctx: ActorContext,
  customerId: string,
  data: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    province?: string | null;
    language?: string | null;
    notes?: string | null;
    status?: CustomerStatus;
    tags?: string[];
  }
) {
  const existing = await getOwnedCustomer(db, ctx.workspaceId, customerId);

  if (data.phone !== undefined && data.phone !== null) {
    const clash = await db.customer.findFirst({
      where: { workspaceId: ctx.workspaceId, phone: data.phone, id: { not: customerId } },
      select: { id: true },
    });
    if (clash) throw new ConflictError("Another customer already uses this phone number");
  }

  if (data.tags && data.tags.length > MAX_TAGS) {
    throw new AppError(`At most ${MAX_TAGS} tags allowed`, 422, "VALIDATION_ERROR");
  }

  const updated = await db.customer.update({
    where: { id: customerId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.province !== undefined ? { province: data.province } : {}),
      ...(data.language !== undefined ? { language: data.language } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
    },
  });

  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "customer.updated",
    entityType: "Customer",
    entityId: customerId,
    ip: ctx.ip,
    metadata: { fields: Object.keys(data) },
  });

  await eventBus.publish(
    makeEvent("CustomerUpdated", ctx.workspaceId, { customerId, fields: Object.keys(data) })
  );

  void existing;
  return updated;
}

