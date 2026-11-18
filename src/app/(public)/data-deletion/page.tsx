import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { DELETION } from "@/modules/legal/content";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "تعليمات حذف البيانات · Data Deletion Instructions — Zaki response",
  robots: { index: true, follow: true },
};

export default function DataDeletionPage() {
  return <LegalPage content={DELETION} />;
}
