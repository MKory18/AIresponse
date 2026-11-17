import { NextResponse, type NextRequest } from "next/server";

// ثابت هون (مش مستورد) لأن الـmiddleware بيشتغل بـEdge runtime بلا باقي الوحدات.
// نفس قيمة `PATH_HEADER` بـ`modules/auth/page-guard.ts` — `tests/page-guard.test.ts` بيتأكد.
const PATH_HEADER = "x-zaki-path";

/**
 * بيمرّر مسار الطلب للـlayout (الـlayout بـApp Router ما بيشوف pathname) علشان حارس الصفحات
 * يقدر يقرر. بيمسح أي قيمة جاية من العميل بنفس الاسم — ما بنصدّق هيدر مرسل من برّا.
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // صفحات بس: لا API ولا ملفات ثابتة.
  matcher: ["/((?!api/|_next/|brand/|favicon|icon|manifest|.*\\..*).*)"],
};
