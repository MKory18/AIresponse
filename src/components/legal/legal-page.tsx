import Link from "next/link";
import {
  APP_NAME,
  LEGAL_UPDATED,
  getContactEmail,
  type LegalDoc,
  type LegalPageContent,
} from "@/modules/legal/content";

/**
 * صفحة قانونية علنية (بلا تسجيل دخول): عربي ثم إنجليزي بنفس الصفحة — مراجع ميتا بيقرأ الإنجليزي.
 * خادمية بالكامل؛ بريد التواصل بيجي من البيئة وقت الطلب (الصفحة `force-dynamic`).
 */

const NAV = [
  { href: "/privacy", ar: "سياسة الخصوصية", en: "Privacy Policy" },
  { href: "/terms", ar: "شروط الاستخدام", en: "Terms of Service" },
  { href: "/data-deletion", ar: "حذف البيانات", en: "Data Deletion" },
];

function DocBlock({ doc, lang, email }: { doc: LegalDoc; lang: "ar" | "en"; email: string | null }) {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const contactLabel = lang === "ar" ? "التواصل" : "Contact";
  const contactText =
    lang === "ar"
      ? "للأسئلة أو طلبات الحذف راسلنا على:"
      : "For questions or deletion requests, email us at:";
  const missing =
    lang === "ar"
      ? "عنوان التواصل غير مضبوط بعد على هذا الخادم."
      : "The contact address has not been configured on this server yet.";
  return (
    <section lang={lang} dir={dir} className="mb-12">
      <h2 className="mb-2 text-2xl font-bold text-ink">{doc.title}</h2>
      <p className="mb-6 text-caption text-ink-muted">
        {lang === "ar" ? "آخر تحديث" : "Last updated"}: {LEGAL_UPDATED}
      </p>
      <p className="mb-6 leading-8 text-ink">{doc.intro}</p>
      {doc.sections.map((s) => (
        <div key={s.heading} className="mb-6">
          <h3 className="mb-2 text-lg font-bold text-ink">{s.heading}</h3>
          {s.paragraphs?.map((p) => (
            <p key={p} className="mb-2 leading-8 text-ink">
              {p}
            </p>
          ))}
          {s.items && (
            <ul className={`list-disc space-y-1 leading-8 text-ink ${lang === "ar" ? "pr-6" : "pl-6"}`}>
              {s.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <div className="rounded-lg border border-line bg-surface-2 p-4">
        <h3 className="mb-1 text-lg font-bold text-ink">{contactLabel}</h3>
        {email ? (
          <p className="leading-8 text-ink">
            {contactText}{" "}
            <a className="text-primary underline" dir="ltr" href={`mailto:${email}`}>
              {email}
            </a>
          </p>
        ) : (
          <p className="leading-8 text-ink-muted">{missing}</p>
        )}
      </div>
    </section>
  );
}

export function LegalPage({ content }: { content: LegalPageContent }) {
  const email = getContactEmail();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <span className="text-lg font-bold text-ink">{APP_NAME}</span>
        <nav aria-label="legal" className="flex flex-wrap gap-4 text-caption">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-primary underline-offset-2 hover:underline">
              {n.ar} · {n.en}
            </Link>
          ))}
        </nav>
      </header>
      <DocBlock doc={content.ar} lang="ar" email={email} />
      <hr className="mb-12 border-line" />
      <DocBlock doc={content.en} lang="en" email={email} />
    </main>
  );
}
