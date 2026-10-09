-- سيستم 7 — B2: ربط الـ OMS + تحصين محدد السرعة على قاعدة البيانات.
-- الـ OMS مالك الطلبات بعد التأكيد والأسعار والعروض؛ نظامك مالك المحادثات والمسودات والذكاء.

-- Product: حقول البيع المزامنة من الـ OMS (حقول البيع المحلية لا تُمس)
ALTER TABLE "Product" ADD COLUMN "syncedFromOms" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "wholesalePrice" DECIMAL(12,2);
ALTER TABLE "Product" ADD COLUMN "discountCap" DECIMAL(12,2);
ALTER TABLE "Product" ADD COLUMN "offers" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Product" ADD COLUMN "complementarySkus" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Customer: القائمة السوداء مصدرها الـ OMS
ALTER TABLE "Customer" ADD COLUMN "isBlacklisted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN "blacklistSource" TEXT;

-- Order: الترحيل للـ OMS بعد التأكيد + مصدر الإعلان
ALTER TABLE "Order" ADD COLUMN "omsOrderId" TEXT;
ALTER TABLE "Order" ADD COLUMN "omsStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "handedOffAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "adSource" TEXT;
CREATE UNIQUE INDEX "Order_omsOrderId_key" ON "Order"("omsOrderId");

-- OmsConnection: اتصال الـ OMS لكل مستأجر (التوكن مشفّر AES-256-GCM)
CREATE TABLE "OmsConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastProductSyncAt" TIMESTAMP(3),
    "lastCustomerSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OmsConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OmsConnection_workspaceId_key" ON "OmsConnection"("workspaceId");
ALTER TABLE "OmsConnection" ADD CONSTRAINT "OmsConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RateLimitEntry: محدد السرعة على قاعدة البيانات (بدل الذاكرة — B1)
CREATE TABLE "RateLimitEntry" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitEntry_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "RateLimitEntry_resetAt_idx" ON "RateLimitEntry"("resetAt");
