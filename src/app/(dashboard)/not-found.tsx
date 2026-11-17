import Link from "next/link";
import { SearchX } from "lucide-react";

/** صفحة/عنصر مش موجود ضمن اللوحة (طلب انحذف · رابط قديم): رسالة + رجوع لـ«اليوم». */
export default function DashboardNotFound() {
  return (
    <div data-dashboard-not-found className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
      <SearchX size={32} className="text-ink-subtle" aria-hidden />
      <h1 className="text-base font-semibold text-ink">ما لقينا هالصفحة</h1>
      <p className="text-sm text-ink-muted">يمكن انحذفت أو الرابط قديم.</p>
      <Link href="/dashboard" className="rounded-control bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-focus">
        ارجع لليوم
      </Link>
    </div>
  );
}
