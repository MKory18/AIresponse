import { notFound } from "next/navigation";
import AuthForm from "@/components/auth-form";
import { isSignupAllowed } from "@/core/signup-gate";

// بيتقرا وقت الطلب (متغيّر بيئة) — مش وقت البناء.
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  // S-06: التسجيل العام مسكّر بالإنتاج.
  if (!isSignupAllowed()) notFound();
  return <AuthForm mode="register" signupEnabled />;
}
