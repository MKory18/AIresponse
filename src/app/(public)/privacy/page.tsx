import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { PRIVACY } from "@/modules/legal/content";

// بتقرا `LEGAL_CONTACT_EMAIL` وقت الطلب — الـDockerfile بيبني بلا بيئة.
export const dynamic = "force-dynamic";

// الجذر `robots: noindex`؛ الصفحات القانونية لازم تنفتح لميتا والزبائن.
export const metadata: Metadata = {
  title: "سياسة الخصوصية · Privacy Policy — Zaki response",
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <LegalPage content={PRIVACY} />;
}
