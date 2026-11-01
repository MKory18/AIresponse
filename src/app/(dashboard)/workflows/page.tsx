import { redirectToMerged } from "@/lib/nav-redirect";

/**
 * «سير العمل» كانت نفس جدول «القواعد» بقائمة تانية — اندمجت بـ`/automation`
 * (زر «قاعدة بخطوات»). الرابط القديم بيحوّل لهناك.
 */
export default function WorkflowsPage() {
  redirectToMerged("/workflows");
}
