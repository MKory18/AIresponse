import type { Prisma } from "@prisma/client";
import { OpenAICompatibleProvider } from "@/modules/ai/provider";
import { getWorkspaceProvider } from "@/modules/ai/router";

type Db = Prisma.TransactionClient;

/**
 * خطوات البداية — «الخطوة بتودي للتانية».
 *
 * ⚠️ قبل: ولا دليل بكل الموقع. المستخدم الجديد بيفتح ويشوف ٢٢ بند وما بيعرف
 * من وين يبلّش ولا شو الي ناقص ليشتغل الوكيل.
 *
 * 🔧 هلأ: كل خطوة بتتعلّم «خلصت» **من بياناتك الحقيقية** (قناة متصلة فعلًا ·
 * منتج فعّال فعلًا …) — مش زر «خلصت» بتضغطه، فما بتكذب عليك. القراءة بس:
 * ولا كتابة، ومحصورة بمساحتك.
 */

export type SetupStepKey = "channel" | "products" | "persona" | "knowledge" | "playground" | "go-live";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  /** سطر واحد: ليش هالخطوة وشو بتعمل. */
  hint: string;
  href: string;
  done: boolean;
  /** `false` = موصى بها بس مش شرط لتشغيل الوكيل. */
  required: boolean;
}

export interface SetupProgress {
  steps: SetupStep[];
  doneCount: number;
  total: number;
  /** أول خطوة ما خلصت (بالترتيب) — الي الواجهة بتضيّئها. */
  nextKey: SetupStepKey | null;
  /** كل الخطوات **الإجبارية** خلصت (الموصى بها ما بتمنع). */
  complete: boolean;
}

/**
 * هل في مزوّد ذكاء حقيقي بمفتاح فعلًا؟ نفس منطق «الاستوديو»
 * (`getWorkspaceProvider` — فشل-مغلق عند غياب المفتاح)، مش مجرّد «اخترت مزوّد».
 * بلا شبكة: بيفحص وجود المفتاح والعنوان، مش بيرسل شي.
 */
function providerReady(settings: Record<string, unknown> | null): boolean {
  try {
    const p = getWorkspaceProvider(settings as never);
    return (
      p.delivery !== "local" &&
      p instanceof OpenAICompatibleProvider &&
      p.hasCredentials &&
      p.endpointUrl.trim().length > 0
    );
  } catch {
    return false;
  }
}

export async function getSetupProgress(db: Db, workspaceId: string): Promise<SetupProgress> {
  const [channels, products, personas, faqs, docs, sessions, settings] = await Promise.all([
    db.channel.count({ where: { workspaceId, status: "CONNECTED" } }),
    db.product.count({ where: { workspaceId, isActive: true, isArchived: false } }),
    db.persona.count({ where: { workspaceId, isActive: true } }),
    // المعرفة: سؤال شائع فعّال أو مستند جاهز للبحث (الي لسا بيتجهّز ما بيفيد الوكيل).
    db.faq.count({ where: { workspaceId, isActive: true } }),
    db.knowledgeDocument.count({ where: { workspaceId, isActive: true, status: "READY" } }),
    db.playgroundSession.count({ where: { workspaceId } }),
    // قراءة بس — الاستوديو بيعمل upsert، وهون ما بنكتب شي.
    db.aISettings.findUnique({ where: { workspaceId } }),
  ]);

  const s = settings as unknown as Record<string, unknown> | null;
  const live = Boolean(s && s.aiEnabled && s.autoRespond) && providerReady(s);

  const steps: SetupStep[] = [
    {
      key: "channel",
      label: "اربط قناة",
      hint: "فيسبوك أو واتساب أو تيليغرام — من هون بتوصل رسائل عملائك.",
      href: "/channels",
      done: channels > 0,
      required: true,
    },
    {
      key: "products",
      label: "أضف منتجاتك",
      hint: "الوكيل بيجاوب بأسعارك ومواصفاتك — بلا منتجات ما عنده شي يبيعه.",
      href: "/products",
      done: products > 0,
      required: true,
    },
    {
      key: "persona",
      label: "اضبط شخصية الوكيل",
      hint: "اللهجة والنبرة وأسلوب البيع. اختياري — في شخصية عامة جاهزة.",
      href: "/personas",
      done: personas > 0,
      required: false,
    },
    {
      key: "knowledge",
      label: "علّمه أجوبة أسئلتك",
      hint: "التوصيل والإرجاع والضمان… أسئلة شائعة بيجاوب منها بدل ما يخمّن.",
      href: "/knowledge",
      done: faqs + docs > 0,
      required: false,
    },
    {
      key: "playground",
      label: "جرّب الوكيل",
      hint: "اكتب له متل ما بيكتب زبونك، وشوف رده قبل ما يصير حقيقي.",
      href: "/ai/playground",
      done: sessions > 0,
      required: false,
    },
    {
      key: "go-live",
      label: "شغّل الرد الآلي",
      hint: "اختر مزوّد ذكاء حقيقي (بمفتاحه) وفعّل الرد الآلي — وقتها الوكيل بيرد لحاله.",
      href: "/settings/ai",
      done: live,
      required: true,
    },
  ];

  const doneCount = steps.filter((x) => x.done).length;
  return {
    steps,
    doneCount,
    total: steps.length,
    nextKey: steps.find((x) => !x.done)?.key ?? null,
    complete: steps.filter((x) => x.required).every((x) => x.done),
  };
}
