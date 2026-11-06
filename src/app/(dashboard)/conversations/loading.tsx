import { Skeleton } from "@/components/ui/skeleton";

/** هيكل فوري عند التنقّل للوارد — الصفحة ما بتوقف فاضية. */
export default function ConversationsLoading() {
  return (
    <div className="page-wrap space-y-3">
      <Skeleton className="h-9 w-52" />
      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[420px] w-full rounded-2xl" />
      </div>
    </div>
  );
}
