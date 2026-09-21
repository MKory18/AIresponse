import { NextResponse } from "next/server";
import { createHandler } from "@/core/api/handler";
import { clearSessionCookie } from "@/modules/auth/session";

export const POST = createHandler({ public: true }, async () => {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", process.env.APP_URL ?? "http://localhost:3000"), { status: 303 });
});
