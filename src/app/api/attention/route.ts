import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { getAttention } from "@/modules/attention/service";

/**
 * GET /api/attention — «يحتاجك»: قائمة وحدة محسوبة (مش مخزّنة)، مفلترة بصلاحيات الطالب، كاش 15 ثانية لكل مساحة.
 * مفتوحة لكل عضو فعّال: اللي ما بيحق له يشوفه ما بيوصله (كل بند مربوط بصلاحية معالجته).
 */
export const GET = createHandler({}, async ({ auth }) => ok(await getAttention(prisma, auth!.workspaceId, auth!.can)));
