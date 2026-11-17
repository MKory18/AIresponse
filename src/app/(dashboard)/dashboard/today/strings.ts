/** نصوص «اليوم» (التسميات من القاموس `lib/glossary.ts`). التسميات = فصحى مبسّطة، الشرح = محكية خفيفة. */
export const TODAY_STRINGS = {
  ranges: [
    { value: "today", label: "اليوم" },
    { value: "yesterday", label: "أمس" },
    { value: "7d", label: "7 أيام" },
    { value: "30d", label: "30 يوم" },
  ],
  needsYou: "يحتاجك الآن",
  needsYouAll: "كل البنود",
  settling: "بتتثبّت هلأ",
  settlingEmpty: "ما في طلبات بانتظار التثبيت هلأ.",
  recent: "آخر الطلبات",
  recentEmpty: "أول طلب بيوصل بيظهر هون.",
  recentEmptyAction: "شوف الطلبات",
  howWeCount: "كيف بنحسبه",
  noBasis: "ما في بيانات كافية للمقارنة",
  loadError: "تعذّر تحميل الأرقام",
  retry: "أعد المحاولة",
  lowSample: "بتظهر لما يكون في 5 محادثات على الأقل",
} as const;
