/**
 * إعدادات الذكاء — منطق عرض حقول الاتصال + إعداد جاهز لبوابة GLM.
 *
 * المفتاح ليس هنا أبداً: ينكتب من الواجهة وينخزن مشفّراً في قاعدة البيانات.
 * هذا الملف بيحدّد أي حقول تظهر لكل مزوّد، وبيمنع تكرار الشروط بالصفحة.
 */
export type AiConnectionMode = "custom" | "endpoint" | "environment";

export function aiConnectionMode(provider: string): AiConnectionMode {
  if (provider === "custom") return "custom";
  if (provider === "internal" || provider === "hermes") return "endpoint";
  return "environment";
}

/**
 * بوابة ZakiAI المتوافقة مع OpenAI. النماذج مختارة حسب المهمة:
 * الرخيص للتصنيف/التلخيص، السريع للاستخراج، الأقوى للرد، ورؤية للصور.
 * التضمينات محلية — ما منعبّيها.
 */
export const GLM_ZAKIAI_PRESET = {
  label: "GLM (ZakiAI)",
  baseUrl: "https://glm.erv.zakiai.io/v1",
  models: {
    classificationModel: "auto/cheap",
    extractionModel: "auto/fast",
    responseModel: "auto/best-chat",
    visionModel: "auto/best-vision",
    summaryModel: "auto/cheap",
  },
} as const;
