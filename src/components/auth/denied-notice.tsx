"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ShieldAlert, X } from "lucide-react";

function Notice() {
  const params = useSearchParams();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  const denied = params.get("denied") === "1";

  useEffect(() => {
    if (!denied) return;
    setDismissed(false);
    // نشيل العلم من الرابط بلا إعادة تحميل علشان ما يرجع التنبيه عند الرجوع/التحديث.
    const next = new URLSearchParams(params.toString());
    next.delete("denied");
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }, [denied, params, pathname]);

  if (!denied || dismissed) return null;
  return (
    <div role="status" data-denied-notice className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-ink">
      <ShieldAlert size={14} className="shrink-0 text-amber-600" />
      <span className="flex-1">ما عندك صلاحية لهالصفحة — رجّعناك لأول صفحة مسموحة. لو بتحتاجها اطلب من المدير.</span>
      <button type="button" aria-label="إغلاق" onClick={() => setDismissed(true)} className="text-ink-subtle hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}

/** تنبيه «ما عندك صلاحية» بعد التحويل من حارس الصفحات (`?denied=1`). */
export function DeniedNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
