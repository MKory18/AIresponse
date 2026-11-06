import { Skeleton } from "@/components/ui/skeleton";

/** هيكل فوري عند التنقّل للطلبات. */
export default function OrdersLoading() {
  return (
    <div className="page-wrap space-y-3">
      <Skeleton className="h-9 w-40" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[360px] w-full rounded-2xl" />
    </div>
  );
}
