import { z } from "zod";

/** z.coerce.boolean() turns the string "false" into true, so parse it explicitly. */
const booleanQueryParam = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const catalogListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  isActive: booleanQueryParam.optional(),
  channelId: z.string().cuid().optional(),
  sort: z.enum(["name", "updated"]).optional(),
});
