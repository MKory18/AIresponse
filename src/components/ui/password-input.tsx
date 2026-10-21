"use client";

import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/input";

/**
 * حقل كلمة سر (أو مفتاح/توكن) مع زر عين: بتشوف شو كتبت وبتخفيه بضغطة.
 *
 * ⚠️ قبل: كل حقل سري كان `<Input type="password">` خام — ما في طريقة تتأكد إنك
 * كتبته صح (وعالجوال أصعب)، فالغلطة بتبان بس لما الدخول يترفض.
 *
 * 🔧 هلأ: أي حقل سري بالموقع بيمرّ من هون (`tests/password-input.test.ts` بيمنع
 * `type="password"` الخام). `kind="secret"` للمفاتيح والتوكنات (الزر بيقول «القيمة»).
 */

export type PasswordKind = "password" | "secret";

/** نوع الحقل ونص الزر حسب الحالة — دالة صرفة عشان الاختبار يغطّيها بلا DOM. */
export function passwordToggle(visible: boolean, kind: PasswordKind = "password") {
  const what = kind === "secret" ? "القيمة" : "كلمة المرور";
  return {
    type: visible ? ("text" as const) : ("password" as const),
    label: `${visible ? "إخفاء" : "إظهار"} ${what}`,
  };
}

export type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  kind?: PasswordKind;
};

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { className, kind = "password", dir, ...props },
  ref
) {
  const [visible, setVisible] = useState(false);
  const toggle = passwordToggle(visible, kind);
  return (
    // `dir` على الغلاف كمان: الحقول سرية غالبًا `ltr` (النص من الشمال) فالعين لازم
    // تقعد بنهاية الحقل حسب اتجاهه (`end-*`) — وإلا بتغطّي أول حرف.
    <div dir={dir} className="relative">
      <Input
        ref={ref}
        {...props}
        dir={dir}
        type={toggle.type}
        // `-ms-reveal`: إيدج بيحط عين خاصة فيه على حقول الباسورد — بلاها منعًا للعينين.
        className={cn("pe-10 [&::-ms-clear]:hidden [&::-ms-reveal]:hidden", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        // الماوس ما بيسرق التركيز من الحقل (تكمّل كتابة بعد ما تتطمّن)؛ الكيبورد بيوصله بـTab عادي.
        onMouseDown={(e) => e.preventDefault()}
        aria-label={toggle.label}
        title={toggle.label}
        className="absolute end-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  );
});
