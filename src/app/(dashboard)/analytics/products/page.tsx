import { redirectToMerged } from "@/lib/nav-redirect";

/** جدول أداء المنتجات صار تبويب «المنتجات» بالتقارير — الرابط بيحوّل للتبويب. */
export default function ProductAnalyticsPage() {
  redirectToMerged("/analytics/products");
}
