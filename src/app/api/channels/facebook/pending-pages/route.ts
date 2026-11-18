import { z } from "zod";
import { createHandler, ok } from "@/core/api/handler";
import { verifyPagesSelectionToken } from "@/modules/channels/facebook/oauth";
import { AuthenticationError } from "@/core/errors";

const schema = z.object({ selectionToken: z.string().min(20) });

/**
 * POST /api/channels/facebook/pending-pages — أسماء الصفحات اللي ميتا رجّعتها
 * بعد الموافقة، لشاشة الاختيار.
 *
 * ⚠️ الواجهة كانت بتقرا الأسماء من حمولة الرمز مباشرة، بس حمولته صارت مشفّرة
 * (S-03: توكنات الصفحات جواه). فبتشوف قائمة فاضية وبتعرض «ولا صفحة» وهي موجودة.
 * 🔧 الخادم بيتحقق من الرمز (نفس مساحة العمل والمستخدم) وبيرجّع `id` و`name` بس —
 * ولا توكن صفحة بيطلع.
 */
export const POST = createHandler(
  { body: schema, permission: "channels.connect" },
  async ({ auth, body }) => {
    let selection;
    try {
      selection = await verifyPagesSelectionToken(body.selectionToken);
    } catch {
      throw new AuthenticationError("Invalid or expired page selection token");
    }
    if (selection.workspaceId !== auth!.workspaceId || selection.userId !== auth!.userId) {
      throw new AuthenticationError("Selection token does not match the current session");
    }
    return ok({ pages: selection.pages.map((p) => ({ id: p.id, name: p.name })) });
  }
);
