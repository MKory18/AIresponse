-- المرحلة ٣ (تشغيلي) — فهرس تقارير الطلبات حسب المساحة والزمن.
-- ترحيل إضافي فقط: فهرس جديد — لا حذف ولا تغيير بيانات.
-- تقارير getOrderAnalytics / getProductAnalytics تفلتر بـ (workspaceId, createdAt)
-- فالفهرس يمنع تدهور الأداء مع نمو الطلبات.

CREATE INDEX "Order_workspaceId_createdAt_idx" ON "Order"("workspaceId", "createdAt");
