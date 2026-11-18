/** هيكل تحميل لأي صفحة باللوحة (قبل ما توصل بياناتها): شريط عنوان + بطاقات — بلا وميض فاضي. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="جاري التحميل" data-dashboard-loading className="space-y-4">
      <div className="h-7 w-48 animate-pulse rounded-control bg-surface-3" />
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-card bg-surface-3" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-card bg-surface-3" />
    </div>
  );
}
