import { ProductDetailView } from "../v2/detail/product-detail-view";

/** `/products/[id]`: 3 تبويبات (الأساسي · شو بيقول الوكيل · الصور) وحفظ واحد. */
export default function ProductPage({ params }: { params: { id: string } }) {
  return <ProductDetailView id={params.id} />;
}
