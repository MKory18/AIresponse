-- أسماء بديلة للمنتج (الاسم الإنجليزي من الـ OMS، وأي اسم تاني بيعرفه الزبون).
-- إضافة عمود فقط: بلا حذف ولا تغيير نوع.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
