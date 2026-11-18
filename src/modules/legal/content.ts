/**
 * الصفحات القانونية العلنية (سياسة الخصوصية · الشروط · حذف البيانات).
 *
 * ⚠️ ميتا بتطلب رابط سياسة خصوصية علني ورابط تعليمات حذف البيانات قبل ما توافق على
 * أي صلاحية مراسلة (App Review). قبل هاد الملف ما كان إلهم أي صفحة.
 * 🔧 كل جملة هون وصف لسلوك موجود فعلًا بالكود (مراجع بالتعليقات) — ما بنكتب وعد ما بينفّذه النظام.
 *
 * المحتوى بيانات (مش JSX) عشان الاختبار يفحصه (`tests/legal-pages.test.ts`) وعشان نسختين (عربي · إنجليزي)
 * ما يختلفوا بصمت.
 */

export const LEGAL_UPDATED = "2026-11-18";
export const APP_NAME = "Zaki response";

/** مدة معالجة طلب الحذف. أي تغيير هون = تغيير بالتزام المنصة أمام المستخدمين. */
export const DELETION_DAYS = 30;

/**
 * بريد التواصل من `LEGAL_CONTACT_EMAIL` (بيئة الخادم، بتنقرأ وقت الطلب).
 * ⚠️ بلاه ما في عنوان تواصل بالصفحة، وميتا بتطلبه — فالصفحة بتحكي بوضوح إنه ناقص بدل ما تخترع عنوان.
 */
export function getContactEmail(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.LEGAL_CONTACT_EMAIL ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  items?: string[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
}

export interface LegalPageContent {
  ar: LegalDoc;
  en: LegalDoc;
}

export const PRIVACY: LegalPageContent = {
  ar: {
    title: "سياسة الخصوصية",
    intro:
      "تشغّل Zaki response منصة تساعد الأعمال الصغيرة على إدارة محادثات Messenger مع زبائنها والرد عليها وتسجيل الطلبات. هذه السياسة توضح ما نجمعه وكيف نستعمله ومتى نحذفه.",
    sections: [
      {
        heading: "من المسؤول عن البيانات",
        paragraphs: [
          "صاحب الصفحة (النشاط التجاري) هو الجهة التي تقرر لماذا تُعالَج رسائل زبائنه. نحن نعالجها نيابة عنه لتقديم الخدمة فقط.",
        ],
      },
      {
        heading: "البيانات التي نعالجها",
        items: [
          "بيانات حساب مستخدم المنصة: الاسم والبريد الإلكتروني وكلمة المرور (مخزّنة مجزّأة) وصلاحياته.",
          "بيانات صفحة فيسبوك التي يربطها صاحبها: معرّف الصفحة واسمها ورمز وصول الصفحة (مخزّن مشفّرًا).",
          "الرسائل التي يرسلها زبون إلى الصفحة عبر Messenger (نص ومرفقات) والردود عليها، ومعرّف الزبون الخاص بالصفحة (PSID)، والاسم والصورة عندما تتيحهما ميتا.",
          "تفاصيل الطلب التي يعطيها الزبون في المحادثة: الاسم والهاتف والعنوان والمنتج والكمية.",
          "سجلات تشغيل تقنية (أخطاء وأحداث) بلا رموز وصول.",
        ],
      },
      {
        heading: "كيف نستعمل البيانات",
        items: [
          "عرض المحادثات لفريق النشاط التجاري ليرد عليها.",
          "صياغة ردود بمساعد ذكاء اصطناعي يضبطه صاحب الصفحة ويستند إلى منتجاته، وإرسالها إلى زبائن بادروا بمراسلة الصفحة.",
          "تسجيل الطلبات ومتابعتها، وإرسالها إلى نظام الطلبات الخاص بالنشاط التجاري، وإلى مجموعة تيليجرام خاصة إذا فعّلها صاحب الصفحة.",
          "الأمان ومنع إساءة الاستعمال وإصلاح الأعطال.",
        ],
        paragraphs: ["لا نبيع البيانات ولا نستعملها للإعلانات ولا نرسل رسائل لمن لم يراسل الصفحة."],
      },
      {
        heading: "الذكاء الاصطناعي",
        paragraphs: [
          "قد تُعالَج نصوص المحادثة بنموذج ذكاء اصطناعي لصياغة الرد. قبل إرسال أي نص إلى نموذج مستضاف خارج خوادمنا، نستبدل بيانات الاتصال المعروفة للزبون (الاسم والهاتف والبريد والعنوان) برموز مؤقتة، ونعيدها محليًا بعد وصول الرد، ولا نخزّن هذه الرموز. إذا تعذّرت هذه الحماية لا يُرسَل النص.",
        ],
      },
      {
        heading: "مع من نشارك البيانات",
        items: [
          "ميتا (Facebook/Messenger) لتسليم الرسائل واستلامها.",
          "مزوّد نموذج الذكاء الاصطناعي الذي تختاره إدارة المنصة، وفق الحماية الموصوفة أعلاه.",
          "مزوّد الاستضافة الذي يشغّل خوادمنا وقاعدة بياناتنا.",
          "نظام الطلبات الخاص بالنشاط التجاري، ومجموعة تيليجرام الخاصة به إذا فعّلها.",
        ],
      },
      {
        heading: "مدة الاحتفاظ",
        items: [
          "المحادثات والطلبات: تبقى حتى يحذفها النشاط التجاري أو يطلب الزبون حذفها.",
          "الحمولة الخام لأحداث القنوات: تُفرَّغ تلقائيًا بعد 30 يومًا افتراضيًا.",
        ],
      },
      {
        heading: "الأمان",
        paragraphs: [
          "رموز وصول الصفحات مخزّنة مشفّرة (AES-256-GCM) ولا تظهر في الواجهة ولا في السجلات. الاتصال بالمنصة عبر HTTPS، وكل نشاط تجاري يرى بياناته فقط.",
        ],
      },
      {
        heading: "حقوقك وحذف بياناتك",
        paragraphs: [
          "يمكنك طلب الاطلاع على بياناتك أو تصحيحها أو حذفها. خطوات الحذف في صفحة تعليمات حذف البيانات (/data-deletion). نعالج الطلبات الموثّقة خلال 30 يومًا.",
          "لإيقاف وصول المنصة إلى صفحتك: من إعدادات فيسبوك ← التكاملات التجارية، أزل التطبيق.",
        ],
      },
      {
        heading: "الأطفال",
        paragraphs: ["الخدمة غير موجّهة لمن هم دون 13 عامًا ولا نجمع بياناتهم عن قصد."],
      },
      {
        heading: "التعديلات",
        paragraphs: ["نحدّث هذه الصفحة عند تغيّر ممارساتنا، وتاريخ آخر تحديث مذكور أعلاها."],
      },
    ],
  },
  en: {
    title: "Privacy Policy",
    intro:
      "Zaki response runs a platform that helps small businesses manage their Messenger conversations with customers, reply to them and record orders. This policy explains what we collect, how we use it and when we delete it.",
    sections: [
      {
        heading: "Who is responsible for the data",
        paragraphs: [
          "The Page owner (the business) decides why its customers' messages are processed. We process them on the business's behalf, only to provide the service.",
        ],
      },
      {
        heading: "Data we process",
        items: [
          "Platform user account data: name, email, password (stored hashed) and permissions.",
          "Data of the Facebook Page the owner connects: Page ID, name and Page access token (stored encrypted).",
          "Messages a customer sends to the Page through Messenger (text and attachments), the replies, the customer's Page-scoped ID (PSID), and name and picture when Meta provides them.",
          "Order details the customer gives in the conversation: name, phone, address, product and quantity.",
          "Technical operation logs (errors and events) that contain no access tokens.",
        ],
      },
      {
        heading: "How we use the data",
        items: [
          "Show conversations to the business's team so they can reply.",
          "Draft replies with an AI assistant that the Page owner configures and that relies on the owner's products, and send them to customers who have messaged the Page.",
          "Record and track orders, and send them to the business's own order system and, if the owner enables it, to a private Telegram group.",
          "Security, abuse prevention and fixing faults.",
        ],
        paragraphs: [
          "We do not sell data, we do not use it for advertising, and we do not message people who have not messaged the Page.",
        ],
      },
      {
        heading: "Artificial intelligence",
        paragraphs: [
          "Conversation text may be processed by an AI model to draft a reply. Before any text is sent to a model hosted outside our servers, we replace the customer's known contact details (name, phone, email, address) with temporary placeholders and restore them locally after the reply returns; the placeholders are never stored. If this protection cannot be applied, the text is not sent.",
        ],
      },
      {
        heading: "Who we share data with",
        items: [
          "Meta (Facebook/Messenger), to deliver and receive messages.",
          "The AI model provider chosen by the platform operator, under the protection described above.",
          "The hosting provider that runs our servers and database.",
          "The business's own order system, and its private Telegram group if the owner enables it.",
        ],
      },
      {
        heading: "Retention",
        items: [
          "Conversations and orders: kept until the business deletes them or the customer asks for deletion.",
          "Raw channel event payloads: cleared automatically after 30 days by default.",
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "Page access tokens are stored encrypted (AES-256-GCM) and never shown in the interface or logs. The platform is served over HTTPS, and each business sees only its own data.",
        ],
      },
      {
        heading: "Your rights and deleting your data",
        paragraphs: [
          "You can ask to access, correct or delete your data. The deletion steps are on the Data Deletion Instructions page (/data-deletion). We process verified requests within 30 days.",
          "To stop the platform's access to your Page: in Facebook, go to Settings > Business Integrations and remove the app.",
        ],
      },
      {
        heading: "Children",
        paragraphs: ["The service is not directed to children under 13 and we do not knowingly collect their data."],
      },
      {
        heading: "Changes",
        paragraphs: ["We update this page when our practices change; the last update date is shown at the top."],
      },
    ],
  },
};

export const TERMS: LegalPageContent = {
  ar: {
    title: "شروط الاستخدام",
    intro: "باستعمالك Zaki response فإنك توافق على هذه الشروط.",
    sections: [
      {
        heading: "الخدمة",
        paragraphs: [
          "منصة لإدارة محادثات Messenger للأعمال، تتضمن صندوقًا موحّدًا ومساعدًا ذكيًا اختياريًا وتسجيلًا للطلبات.",
        ],
      },
      {
        heading: "الحسابات والصفحات",
        items: [
          "أنت مسؤول عن حسابك وعن من تمنحه صلاحية الدخول.",
          "تربط صفحاتك بنفسك وتؤكد أنك مخوَّل بإدارتها، ويمكنك فصلها في أي وقت.",
        ],
      },
      {
        heading: "الاستعمال المقبول",
        items: [
          "الالتزام بشروط منصة ميتا وسياسات Messenger، ومنها عدم مراسلة من لم يراسل الصفحة أولًا.",
          "عدم استعمال الخدمة للاحتيال أو الرسائل المزعجة أو المحتوى المخالف للقانون.",
          "أنت مسؤول عن محتوى الردود التي تُرسَل باسم صفحتك، بما فيها ما يصوغه المساعد الذكي.",
        ],
      },
      {
        heading: "المساعد الذكي",
        paragraphs: [
          "قد تحتوي ردود الذكاء الاصطناعي على أخطاء. صاحب الصفحة هو من يضبط المساعد ويحدد وضعه (رد آلي أو قراءة فقط) ويراجع الأسعار والمعلومات التي يستند إليها.",
        ],
      },
      {
        heading: "بيانات الزبائن",
        paragraphs: [
          "أنت المسؤول عن إبلاغ زبائنك وعن الأساس القانوني لمعالجة بياناتهم. نعالجها نيابةً عنك وفق سياسة الخصوصية.",
        ],
      },
      {
        heading: "التوافر والإيقاف",
        paragraphs: [
          "نسعى لتوفير الخدمة باستمرار دون ضمان عدم انقطاعها. يجوز لنا إيقاف حساب يخالف هذه الشروط، ويجوز لك إغلاق حسابك في أي وقت.",
        ],
      },
      {
        heading: "حدود المسؤولية",
        paragraphs: [
          "تُقدَّم الخدمة كما هي، وبالقدر الذي يسمح به القانون لا نتحمل خسائر غير مباشرة ناتجة عن استعمالها أو انقطاعها.",
        ],
      },
    ],
  },
  en: {
    title: "Terms of Service",
    intro: "By using Zaki response you agree to these terms.",
    sections: [
      {
        heading: "The service",
        paragraphs: [
          "A platform for managing Messenger conversations for businesses, with a shared inbox, an optional AI assistant and order recording.",
        ],
      },
      {
        heading: "Accounts and Pages",
        items: [
          "You are responsible for your account and for whom you give access to.",
          "You connect your own Pages and confirm you are authorised to manage them. You can disconnect them at any time.",
        ],
      },
      {
        heading: "Acceptable use",
        items: [
          "Follow Meta's platform terms and Messenger policies, including not messaging people who have not messaged the Page first.",
          "Do not use the service for fraud, spam or unlawful content.",
          "You are responsible for the content of replies sent in your Page's name, including replies drafted by the AI assistant.",
        ],
      },
      {
        heading: "The AI assistant",
        paragraphs: [
          "AI replies can contain mistakes. The Page owner configures the assistant, chooses its mode (auto-reply or read-only) and reviews the prices and information it relies on.",
        ],
      },
      {
        heading: "Customer data",
        paragraphs: [
          "You are responsible for informing your customers and for the legal basis for processing their data. We process it on your behalf under our Privacy Policy.",
        ],
      },
      {
        heading: "Availability and suspension",
        paragraphs: [
          "We aim to keep the service available but do not guarantee it will never be interrupted. We may suspend an account that breaks these terms, and you may close your account at any time.",
        ],
      },
      {
        heading: "Limitation of liability",
        paragraphs: [
          "The service is provided as is. To the extent the law allows, we are not liable for indirect losses arising from its use or interruption.",
        ],
      },
    ],
  },
};

export const DELETION: LegalPageContent = {
  ar: {
    title: "تعليمات حذف البيانات",
    intro:
      "يمكنك طلب حذف بياناتك التي تعالجها Zaki response. هذه الصفحة تشرح الخطوات لزبون راسل إحدى الصفحات ولصاحب الصفحة.",
    sections: [
      {
        heading: "إذا كنت زبونًا راسلت صفحة تستعمل المنصة",
        items: [
          "أرسل طلب حذف إلى بريد التواصل أدناه من رسالة تذكر فيها اسم الصفحة التي راسلتها واسم حسابك على فيسبوك (أو رابط ملفك).",
          "نتحقق من أن الطلب لك، وقد نسأل صاحب الصفحة للتأكد.",
          `نحذف محادثاتك وبيانات الطلبات المرتبطة بك من المنصة خلال ${DELETION_DAYS} يومًا من وصول طلب موثّق ونؤكد لك بالرد.`,
          "قد نحتفظ بسجلات محدودة عندما يفرض القانون ذلك أو لحماية حق قانوني.",
        ],
      },
      {
        heading: "إذا كنت صاحب صفحة",
        items: [
          "لإيقاف وصولنا إلى صفحتك: من فيسبوك افتح الإعدادات ← التكاملات التجارية وأزل التطبيق. يمكنك أيضًا فصل الصفحة من المنصة (الصفحات والقنوات).",
          "لحذف محادثة: من المنصة افتح المحادثة واحذفها. الحذف نهائي ويشمل رسائلها وسلتها وما استنتجه المساعد منها.",
          "لحذف حسابك أو مساحة العمل كاملة: اطلب ذلك على البريد أدناه.",
        ],
      },
      {
        heading: "ماذا يُحذف",
        items: [
          "الرسائل والمرفقات المخزّنة وبيانات الزبون المسجّلة (الاسم والهاتف والعنوان) والطلبات المرتبطة.",
          "رموز وصول الصفحة عند فصلها.",
          "الحمولة الخام لأحداث القنوات تُفرَّغ تلقائيًا بعد 30 يومًا حتى بلا طلب.",
        ],
      },
    ],
  },
  en: {
    title: "Data Deletion Instructions",
    intro:
      "You can ask us to delete your data that Zaki response processes. This page explains the steps for a customer who messaged a Page and for a Page owner.",
    sections: [
      {
        heading: "If you are a customer who messaged a Page that uses the platform",
        items: [
          "Send a deletion request to the contact email below, naming the Page you messaged and your Facebook account name (or profile link).",
          "We verify that the request is yours and may ask the Page owner to confirm.",
          `We delete your conversations and the order data linked to you from the platform within ${DELETION_DAYS} days of receiving a verified request, and we confirm by reply.`,
          "We may keep limited records where the law requires it or to protect a legal claim.",
        ],
      },
      {
        heading: "If you are a Page owner",
        items: [
          "To stop our access to your Page: in Facebook open Settings > Business Integrations and remove the app. You can also disconnect the Page in the platform (Pages & Channels).",
          "To delete a conversation: open it in the platform and delete it. Deletion is permanent and covers its messages, cart and what the assistant inferred from it.",
          "To delete your account or the whole workspace: ask at the email below.",
        ],
      },
      {
        heading: "What is deleted",
        items: [
          "Stored messages and attachments, recorded customer details (name, phone, address) and linked orders.",
          "Page access tokens when a Page is disconnected.",
          "Raw channel event payloads are cleared automatically after 30 days even without a request.",
        ],
      },
    ],
  },
};
