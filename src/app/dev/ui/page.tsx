import { notFound } from "next/navigation";
import { Gallery } from "./gallery";

export const metadata = { title: "معرض المكوّنات" };

/**
 * `/dev/ui` — معرض العدّة (2.1): كل مكوّن بكل حالاته، بكل الثيمات فاتح وداكن. مرجع البنّاء والمراجع.
 * بالتطوير بس: `notFound()` بالإنتاج. برّا `(dashboard)` عن قصد (بلا جلسة، وما بيدخل بالقائمة).
 */
export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}
