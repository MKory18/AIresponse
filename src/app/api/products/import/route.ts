import { createHandler, ok } from "@/core/api/handler";
import { AppError } from "@/core/errors";
import { prisma } from "@/core/db/prisma";
import { importProductsFromSheet, IMPORT_MAX_BYTES } from "@/modules/products/import-service";
import { loadAISettings, getWorkspaceProvider } from "@/modules/ai/router";

/**
 * استيراد منتجات من ملف اكسل — تحليل الأعمدة بالذكاء (اختياري) وإدراج تلقائي.
 * الملف يقرأ هنا مباشرة (لا يمرر لأي مزوّد ذكاء بملفات) — الذكاء يتلقى عناوين
 * الأعمدة + 3 صفوف عيّنة فقط لتحديد الخريطة.
 */
export const POST = createHandler(
  { permission: "products.write", rateLimit: { limit: 6, windowMs: 60_000 } },
  async ({ req, auth }) => {
    const form = await req.formData().catch(() => {
      throw new AppError("الطلب لازم يكون رفع ملف (form-data)", 400, "INVALID_FORM");
    });
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError("ما فيه ملف بالطلب — اختر ملف اكسل (.xlsx أو .csv)", 400, "NO_FILE");
    }
    if (file.size === 0) {
      throw new AppError("الملف فاضي", 422, "EMPTY_FILE");
    }
    if (file.size > IMPORT_MAX_BYTES) {
      throw new AppError("حجم الملف كبير (الحد 5 ميجا) — قسم الأوراق أو نظّف الصفوف الفاضية", 422, "FILE_TOO_LARGE");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const settings = await loadAISettings(prisma, auth!.workspaceId);
    let provider = null;
    try {
      provider = getWorkspaceProvider(settings ?? null);
    } catch {
      provider = null; // بلا إعداد ذكاء صالح — التحليل التلقائي المحلي
    }

    const summary = await importProductsFromSheet(
      prisma,
      auth!,
      { buffer, filename: file.name || "import.xlsx" },
      { provider }
    );
    return ok(summary, 201);
  }
);
