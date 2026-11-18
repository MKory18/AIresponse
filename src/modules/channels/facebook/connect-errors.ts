/**
 * سبب فشل ربط الصفحة — بالعربي، مع التصحيح.
 *
 * ⚠️ كل أسباب الفشل كانت بتنعرض برسالة وحدة: «فشل ربط الصفحة — حاول مجددًا».
 * فالمالك اللي ميتا ما رجّعتله ولا صفحة بيضل يحاول ويحاول وما بيعرف إنه
 * السبب عند ميتا مش عنا — وهاد اللي صار فعلًا بعد تبديل تطبيق ميتا.
 * 🔧 كل رمز رجوع إله سبب واضح وخطوة تصحيح — الرمز بيجي من مسار الرجوع
 * (`/api/channels/facebook/callback`) بـ`?fb_error=`.
 */
export type ConnectErrorCode = "no_pages" | "exchange" | "callback" | "selection" | "expired";

export interface ConnectErrorNote {
  /** شو صار (أحمر). */
  risk: string;
  /** شو بتعمل (برتقالي). */
  fix: string;
}

const NOTES: Record<ConnectErrorCode, ConnectErrorNote> = {
  no_pages: {
    risk: "فيسبوك ما رجّع ولا صفحة لهالحساب — إما حسابك مش مدير على أي صفحة، أو ما وافقت على صلاحية عرض الصفحات، أو تطبيق ميتا نوعه Business وبدّو إعداد ربط محفوظ.",
    fix: "تأكد إنك Admin على الصفحة من إعدادات الصفحة، وإذا تطبيق ميتا لسا بوضع التطوير ضيف حسابك بـ App Roles. وإذا نوع التطبيق Business: اعمل إعداد من App Dashboard ← Facebook Login for Business ← Configurations واختار الصفحة وصلاحياتها، وحطّ رقم الإعداد بـ META_LOGIN_CONFIG_ID على الخادم — بلاه ميتا بترجّع صفر صفحات.",
  },
  exchange: {
    risk: "ميتا رفضت إكمال الربط — رقم التطبيق أو سره أو رابط الرجوع ما بيطابقوا اللي مسجّل عندها.",
    fix: "تأكد من META_APP_ID و META_APP_SECRET على الخادم، ومن إنه رابط الرجوع مسجّل حرفيًا بـ Facebook Login ← Settings ← Valid OAuth Redirect URIs.",
  },
  callback: {
    risk: "رجعت من فيسبوك بلا موافقة — إما ألغيت الشاشة أو رفضت صلاحية.",
    fix: "أعد المحاولة من زر «ربط صفحة Facebook» ووافق على الصلاحيات كلها.",
  },
  selection: {
    risk: "انتهت مهلة اختيار الصفحة (١٠ دقائق) أو الرابط ناقص.",
    fix: "أعد الربط من البداية — الاختيار لازم يصير مباشرة بعد الرجوع من فيسبوك.",
  },
  expired: {
    risk: "انتهت مهلة الربط قبل ما ترجع من فيسبوك — المهلة ١٠ دقائق من لحظة ما تضغط «اربط صفحة Facebook»، وشاشات ميتا بتاخد أكتر منها أحيانًا.",
    fix: "أعد الضغط على «اربط صفحة Facebook» وكمّل الشاشات بلا توقف. وإذا كانت الصفحة مفتوحة عندك من قبل، سكّرها وابدأ من جديد — الرابط القديم ما بيزبط مرتين.",
  },
};

/** رمز غير معروف = سبب عام، بس بيضل يقول للمالك وين يدوّر. */
const UNKNOWN: ConnectErrorNote = {
  risk: "فشل ربط الصفحة ولا عندنا سبب واضح من فيسبوك.",
  fix: "أعد المحاولة، وإذا تكرر افحص إعدادات تطبيق ميتا (الصلاحيات ورابط الرجوع).",
};

export function describeConnectError(code: string | null | undefined): ConnectErrorNote {
  const key = (code ?? "").trim() as ConnectErrorCode;
  return NOTES[key] ?? UNKNOWN;
}
