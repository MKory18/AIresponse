import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { claimHandoff, releaseHandoff, resolveHandoff, routeHandoff } from "@/modules/handoffs/handoff-service";
import { z } from "zod";

type Params = { id: string };

const actionSchema = z.object({
  action: z.enum(["claim", "release", "resolve", "route"]),
  strategy: z.enum(["ROUND_ROBIN", "LEAST_LOADED"]).optional(),
});

export const POST = createHandler(
  { body: actionSchema, permission: "handoffs.claim" },
  async ({ auth, body, params, req }) => {
    const { id } = params as Params;
    const ctx = { ...auth!, ip: req.headers.get("x-forwarded-for") ?? undefined };

    switch (body.action) {
      case "claim": {
        const handoff = await claimHandoff(prisma, ctx, id);
        return ok(handoff);
      }
      case "release": {
        const handoff = await releaseHandoff(prisma, ctx, id);
        return ok(handoff);
      }
      case "resolve": {
        // OCR-2026-10-16: الإغلاق النهائي للتحويل قرار أعلى من الاستلام —
        // صلاحية مستقلة (متاحة لSALES_AGENT فما فوق حسب الأدوار).
        auth!.require("handoffs.resolve");
        const handoff = await resolveHandoff(prisma, ctx, id);
        return ok(handoff);
      }
      case "route": {
        const handoff = await routeHandoff(prisma, auth!.workspaceId, id, body.strategy ?? "LEAST_LOADED");
        return ok(handoff);
      }
    }
  }
);
