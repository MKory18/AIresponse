-- كتالوجات المنتجات للصفحات: مجموعات مسماة من منتجات المساحة تُربط بقنوات الصفحات.
-- إضافات فقط: 3 جداول جديدة + مفاتيح وقيودها. ولا حذف ولا تغيير نوع ولا عمود
-- جديد على جدول موجود — الصفوف القديمة (منتجات · قنوات · طلبات) لا تُمس.

-- CreateTable
CREATE TABLE "Catalog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogPageAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "assignedBy" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogPageAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Catalog_workspaceId_name_key" ON "Catalog"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Catalog_workspaceId_isActive_idx" ON "Catalog"("workspaceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_catalogId_productId_key" ON "CatalogProduct"("catalogId", "productId");

-- CreateIndex
CREATE INDEX "CatalogProduct_catalogId_sortOrder_idx" ON "CatalogProduct"("catalogId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogPageAssignment_channelId_key" ON "CatalogPageAssignment"("channelId");

-- CreateIndex
CREATE INDEX "CatalogPageAssignment_workspaceId_catalogId_idx" ON "CatalogPageAssignment"("workspaceId", "catalogId");

-- AddForeignKey
ALTER TABLE "Catalog" ADD CONSTRAINT "Catalog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogPageAssignment" ADD CONSTRAINT "CatalogPageAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogPageAssignment" ADD CONSTRAINT "CatalogPageAssignment_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogPageAssignment" ADD CONSTRAINT "CatalogPageAssignment_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
