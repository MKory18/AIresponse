import AuthForm from "@/components/auth-form";
import { isSignupAllowed } from "@/core/signup-gate";

// بيتقرا وقت الطلب (متغيّر بيئة) — مش وقت البناء.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <AuthForm mode="login" signupEnabled={isSignupAllowed()} />;
}
