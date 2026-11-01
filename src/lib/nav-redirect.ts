import { redirect } from "next/navigation";
import { NAV_REDIRECTS } from "@/lib/nav-model";

/**
 * صفحة اندمجت بغيرها: الرابط القديم بيحوّل لمكانه الجديد بدل ما يعطي ٤٠٤.
 * الوجهة من `NAV_REDIRECTS` بس — مكان واحد بيتعدّل لو تغيّرت.
 */
export function redirectToMerged(path: keyof typeof NAV_REDIRECTS): never {
  redirect(NAV_REDIRECTS[path] ?? "/dashboard");
}
