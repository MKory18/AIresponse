import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { knowledgeUpdateSchema } from "@/modules/products/schemas";
import { archiveDocument, deleteKnowledgeDocument, getOwnedDocument, updateDocument } from "@/modules/knowledge/service";

type Params = { id: string };

export const GET = createHandler(
  { permission: "knowledge.read" },
  async ({ auth, params }) => {
    const { id } = params as Params;
    const doc = await getOwnedDocument(prisma, auth!.workspaceId, id);
    return ok(doc);
  }
);

export const PATCH = createHandler(
  { body: knowledgeUpdateSchema, permission: "knowledge.write" },
  async ({ auth, body, params }) => {
    const { id } = params as Params;
    if (body.isActive === false) {
      const archived = await archiveDocument(prisma, auth!, id);
      return ok(archived);
    }
    const updated = await updateDocument(prisma, auth!, id, body);
    return ok(updated);
  }
);

export const DELETE = createHandler({ permission: "knowledge.write" }, async ({ auth, params }) => {
  const { id } = params as Params;
  const result = await deleteKnowledgeDocument(prisma, auth!, id);
  return ok(result);
});
