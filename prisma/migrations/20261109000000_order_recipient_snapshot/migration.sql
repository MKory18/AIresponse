-- Additive: لقطة اسم وهاتف المستلم على الطلب.
ALTER TABLE "Order" ADD COLUMN "recipientName" TEXT,
ADD COLUMN "recipientPhone" TEXT;
