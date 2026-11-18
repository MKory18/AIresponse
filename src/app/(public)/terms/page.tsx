import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { TERMS } from "@/modules/legal/content";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "شروط الاستخدام · Terms of Service — Zaki response",
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return <LegalPage content={TERMS} />;
}
