import { NextRequest } from "next/server";
import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { extractText } from "@/modules/knowledge/extract";
import { createKnowledgeDocument } from "@/modules/knowledge/service";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const CATEGORIES = ["PRODUCT", "FAQ", "POLICY", "DELIVERY", "PAYMENT", "COMPANY", "DOCUMENT", "CUSTOM"] as const;

/**
 * POST /api/knowledge/upload — multipart file (PDF/TXT/MD/CSV/JSON) →
 * server-side text extraction → knowledge document → async ingestion
 * (chunks → embeddings → pgvector). Returns 202; the document status
 * (PROCESSING → READY/FAILED) is the only source of truth.
 */
export const POST = createHandler({ permission: "knowledge.write" }, async ({ auth, req }) => {
  const form = await (req as NextRequest).formData().catch(() => {
    throw new AppError("Expected multipart/form-data", 400, "INVALID_BODY");
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("file field is required", 422, "VALIDATION_ERROR");

  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const categoryRaw = str("category");
  if (categoryRaw && !(CATEGORIES as readonly string[]).includes(categoryRaw)) {
    throw new AppError(`Invalid category: ${categoryRaw}`, 422, "VALIDATION_ERROR");
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length === 0) throw new AppError("Empty file", 422, "VALIDATION_ERROR");
  if (data.length > MAX_FILE_BYTES) throw new AppError("File exceeds 10MB", 422, "VALIDATION_ERROR");

  let content: string;
  try {
    content = await extractText(file.type || "application/octet-stream", file.name, data);
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : "Text extraction failed", 422, "VALIDATION_ERROR");
  }
  if (!content.trim()) throw new AppError("No extractable text found in file", 422, "VALIDATION_ERROR");

  const title = str("title")?.slice(0, 200) ?? file.name.slice(0, 200);
  const doc = await createKnowledgeDocument(prisma, auth!, {
    title,
    content: content.slice(0, 500_000),
    category: (categoryRaw as (typeof CATEGORIES)[number] | undefined) ?? "DOCUMENT",
    sourceType: "FILE",
  });
  return ok(doc, 202);
});
