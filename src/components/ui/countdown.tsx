"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCountdown } from "@/lib/format";

/**
 * `Countdown` — عدّاد «يتثبّت خلال 08:12» (2.1). بيعدّ تنازليًا لـ`until` من توقيت الجهاز (الخادم هو الحكم الفعلي
 * على التثبيت — العدّاد للعرض بس)، وبينادي `onElapsed` مرة وحدة عند الصفر. ما بينزل تحت 00:00.
 * `now` للاختبار (بيثبّت الساعة).
 */
export function Countdown({
  until,
  label = "يتثبّت خلال",
  doneLabel = "جاهز للتثبيت",
  onElapsed,
  now,
  className,
}: {
  until: string | Date;
  label?: string;
  doneLabel?: string;
  onElapsed?: () => void;
  now?: () => number;
  className?: string;
}) {
  const target = new Date(until).getTime();
  const clock = now ?? Date.now;
  const [left, setLeft] = useState(() => (Number.isFinite(target) ? target - clock() : 0));

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    let fired = false;
    const tick = () => {
      const remaining = target - clock();
      setLeft(remaining);
      if (remaining <= 0 && !fired) {
        fired = true;
        onElapsed?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- الساعة والمعالج ثابتين عمليًا؛ إعادة التشغيل بتغيّر الهدف بس
  }, [target]);

  const done = left <= 0;
  return (
    <span data-countdown className={cn("inline-flex items-center gap-1 text-xs font-medium tabular-nums", done ? "text-success" : "text-warning", className)}>
      <Clock size={12} aria-hidden />
      {done ? doneLabel : `${label} ${formatCountdown(left)}`}
    </span>
  );
}
