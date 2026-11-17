"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** خطأ غير متوقع بصفحة من اللوحة: رسالة بالعربي + «أعد المحاولة» (بدل شاشة بيضا). التفاصيل بالـlog مش للمستخدم. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("dashboard_error", error.digest ?? error.message);
  }, [error]);
  return (
    <div role="alert" data-dashboard-error className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
      <AlertTriangle size={32} className="text-danger" aria-hidden />
      <h1 className="text-base font-semibold text-ink">صار خطأ بهالصفحة</h1>
      <p className="text-sm text-ink-muted">جرّب مرة ثانية، وإذا ضل بتجي، بلّغ الدعم{error.digest ? ` (رمز: ${error.digest})` : ""}.</p>
      <Button onClick={reset}>أعد المحاولة</Button>
    </div>
  );
}
