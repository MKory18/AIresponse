import { prisma } from "@/core/db/prisma";
import { hashPassword } from "@/modules/auth/password";

const DEMO_EMAIL = "admin@demo.local";
const DEMO_PASSWORD = "Demo#2026!";

const MIN = 60 * 1000;

async function main() {
  // Idempotent seed. Demo data is only for local development / docker-compose.
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log("Demo seed already applied — skipping.");
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const user = await prisma.user.create({
    data: { email: DEMO_EMAIL, name: "Demo Admin", passwordHash },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: "Demo Store",
      slug: "demo-store",
      members: { create: { userId: user.id, role: "OWNER", status: "ACTIVE" } },
      aiSettings: { create: {} },
      personas: {
        create: {
          name: "Sara",
          tone: "friendly",
          language: "ar",
          dialect: "syrian",
          formality: "informal",
          emojiLevel: 1,
          responseLength: "short",
          salesStyle: "helpful",
        },
      },
    },
    include: { personas: true },
  });

  // Single channel: Facebook Messenger (per product scope).
  const fbChannel = await prisma.channel.create({
    data: { workspaceId: workspace.id, type: "FACEBOOK", displayName: "Facebook Page — Demo", status: "CONNECTED" },
  });

  // ── Products (5) with variants + FAQs ──
  const productSpecs = [
    {
      name: "ماء الكمأة", sku: "TRUFFLE-WATER-500", price: 150000, compareAtPrice: 180000, currency: "SYP",
      category: "مشروبات", shortDescription: "ماء طبيعي بجزيئات الكمأة الفاخر",
      description: "ماء معدني طبيعي مُدعّم بجزيئات الكمأة الحقيقية، عبوة ٥٠٠ مل. يُقدم مثلجًا للحصول على أفضل طعم.",
      benefits: ["نكهة كمأة طبيعية فاخرة", "خالٍ من السكر والسعرات", "مناسب للمناسبات والضيافة"],
      usage: "يُقدم مثلجًا. يُحفظ في مكان بارد بعيدًا عن الشمس.",
      objections: ["السعر مرتفع — منتج فاخر موسمي", "لا أعرف الكمأة — نكهة خفيفة راقية غير مبالغة"],
      warnings: null as string | null,
      faqs: [
        { question: "بكم ماء الكمأة؟", answer: "سعره ١٥٠ ألف ل.س للعبوة ٥٠٠ مل." },
        { question: "هل يوجد توصيل؟", answer: "نعم، التوصيل متاح لجميع المحافظات خلال 24-48 ساعة." },
        { question: "هل يحتوي سكر؟", answer: "لا، خالٍ تمامًا من السكر." },
      ],
      variants: [{ name: "عبوة كبيرة 1 لتر", sku: "TRUFFLE-WATER-1000", price: 250000, stockQty: 15 }],
    },
    {
      name: "عسل الكمأة", sku: "TRUFFLE-HONEY-250", price: 320000, compareAtPrice: null, currency: "SYP",
      category: "أطعمة", shortDescription: "عسل طبيعي مع شرائح الكمأة",
      description: "عسل جبلي طبيعي 100% مع شرائح كمأة حقيقية، برطمان ٢٥٠ غرام. مثالي للفطور والهدايا.",
      benefits: ["عسل طبيعي غير مبستر", "شرائح كمأة حقيقية", "تغليف هدايا مجاني"],
      usage: "يُحفظ في مكان جاف. لا يُسخن على نار مباشرة.",
      objections: ["هل عسل طبيعي؟ — مرفق تحليل مخبري لكل دفعة"],
      warnings: "غير مخصص للأطفال دون سنة.",
      faqs: [
        { question: "هل العسل طبيعي؟", answer: "نعم، عسل جبلي طبيعي 100% مع تحليل مخبري لكل دفعة." },
        { question: "كم مدة الصلاحية؟", answer: "سنتان من تاريخ الإنتاج." },
        { question: "هل يتوفر تغليف هدايا؟", answer: "نعم، التغليف مجاني مع أي طلب." },
      ],
      variants: [],
    },
    {
      name: "زيت الكمأة", sku: "TRUFFLE-OIL-100", price: 210000, compareAtPrice: 240000, currency: "SYP",
      category: "أطعمة", shortDescription: "زيت زيتون ممزوج بالكمأة",
      description: "زيت زيتون بكر ممتاز مُنقّع بكمأة حقيقية، زجاجة ١٠٠ مل مع قطارة.",
      benefits: ["قطرات قليلة تكفي لإعطاء نكهة فاخرة", "زيت زيتون بكر ممتاز", "قطارة للتحكم بالكمية"],
      usage: "يُضاف بعد الطهي على السلطات والمعكرونة والبيتزا.",
      objections: ["كيف أستخدمه؟ — بعد الطهي فقط، لا يُسخن مباشرة"],
      warnings: null as string | null,
      faqs: [
        { question: "كيف أستخدم زيت الكمأة؟", answer: "يُضاف بعد الطهي على الأطباق الجاهزة، ولا يُسخن مباشرة." },
        { question: "هل يوجد توصيل؟", answer: "نعم، لجميع المحافظات خلال 24-48 ساعة." },
      ],
      variants: [],
    },
    {
      name: "مجموعة الهدايا", sku: "TRUFFLE-GIFT-SET", price: 550000, compareAtPrice: 620000, currency: "SYP",
      category: "هدايا", shortDescription: "ماء + عسل + زيت الكمأة في علبة فاخرة",
      description: "مجموعة كاملة: ماء الكمأة، عسل الكمأة، وزيت الكمأة في علبة خشبية فاخرة مع بطاقة إهداء.",
      benefits: ["توفير ١٥٪ عن الشراء المنفصل", "علبة خشبية فاخرة", "بطاقة إهداء مجانية"],
      usage: "تُطلب قبل ٤٨ ساعة لضمان تجهيز الهدية.",
      objections: ["غالية — توفر ١٥٪ وتغليف فاخر مجاني"],
      warnings: null as string | null,
      faqs: [
        { question: "بكم مجموعة الهدايا؟", answer: "٥٥٠ ألف ل.س بدل ٦٢٠ ألف — توفير ١٥٪." },
        { question: "هل يمكن إضافة بطاقة إهداء؟", answer: "نعم، البطاقة مجانية — أرسل النص مع الطلب." },
      ],
      variants: [],
    },
    {
      name: "شاي الكمأة الأخضر", sku: "TRUFFLE-TEA-50", price: 95000, compareAtPrice: null, currency: "SYP",
      category: "مشروبات", shortDescription: "شاي أخضر بنكهة الكمأة",
      description: "شاي أخضر عالي الجودة بنكهة كمأة طبيعية، علبة ٥٠ غرام (٢٥ كيسًا).",
      benefits: ["مضادات أكسدة", "نكهة مميزة هادئة", "خالٍ من الكافيين تقريبًا"],
      usage: "كيس لكل كوب، ماء ساخن (ليس مغليًا)، ٣-٥ دقائق.",
      objections: ["نكهة غريبة؟ — نكهة خفيفة محببة حتى للمبتدئين"],
      warnings: null as string | null,
      faqs: [
        { question: "بكم الشاي؟", answer: "٩٥ ألف ل.س للعلبة (٢٥ كيسًا)." },
        { question: "هل يحتوي كافيين؟", answer: "نسبة ضئيلة جدًا، مناسب للمساء." },
      ],
      variants: [],
    },
  ];

  const products = [] as { id: string; name: string; price: number; currency: string }[];
  for (const spec of productSpecs) {
    const p = await prisma.product.create({
      data: {
        workspaceId: workspace.id,
        name: spec.name,
        sku: spec.sku,
        shortDescription: spec.shortDescription,
        description: spec.description,
        price: spec.price,
        compareAtPrice: spec.compareAtPrice,
        currency: spec.currency,
        category: spec.category,
        benefits: spec.benefits,
        usage: spec.usage,
        objections: spec.objections,
        warnings: spec.warnings,
        stockQty: 40,

        variants: {
          create: spec.variants.map((v) => ({ ...v, currency: spec.currency })),
        },
      },
    });
    for (const f of spec.faqs) {
      await prisma.faq.create({
        data: { workspaceId: workspace.id, productId: p.id, question: f.question, answer: f.answer },
      });
    }
    products.push({ id: p.id, name: p.name, price: spec.price, currency: spec.currency });
  }

  // ── Customers (3) with Facebook identities ──
  const customerSpecs = [
    { name: "محمد العلي", phone: "0930000000", province: "دمشق", identity: "fb-100644551100001" },
    { name: "ريم حداد", phone: "0944111222", province: "حلب", identity: "fb-100644551100002" },
    { name: "خالد الشامي", phone: "0955333444", province: "حمص", identity: "fb-100644551100003" },
  ];
  const customers = [] as { id: string; name: string }[];
  for (const cs of customerSpecs) {
    const c = await prisma.customer.create({
      data: {
        workspaceId: workspace.id,
        name: cs.name,
        phone: cs.phone,
        province: cs.province,
        status: "INTERESTED",
        identities: {
          create: { workspaceId: workspace.id, channelType: "FACEBOOK", channelExternalId: cs.identity, displayName: cs.name },
        },
      },
    });
    customers.push({ id: c.id, name: cs.name });
  }

  // ── Conversations (5, Facebook only) ──
  const now = Date.now();
  const ago = (mins: number) => new Date(now - mins * MIN);

  type Spec = {
    customerId: string; ext: string; status: "OPEN" | "PENDING" | "RESOLVED" | "CLOSED";
    aiState: "AI_ACTIVE" | "HUMAN_ACTIVE"; unread: number; priority?: "HIGH" | "URGENT";
    assigned?: boolean; minutesAgo: number; script: string[];
  };

  const specs: Spec[] = [
    {
      customerId: customers[0].id, ext: "fb-conv-1", status: "OPEN", aiState: "AI_ACTIVE",
      unread: 2, priority: "HIGH", minutesAgo: 8,
      script: [
        "in:مرحبا، بدي أعرف بكم ماء الكمأة؟",
        "ai:أهلا وسهلا 🌹 ماء الكمأة ٥٠٠ مل سعره ١٥٠ ألف ل.س، ومتوفر حاليًا.",
        "in:وعملت التوصيل لدمشق؟",
        "ai:أي نعم، التوصيل متوفر لجميع المحافظات، ويوصل دمشق خلال ٢٤-٤٨ ساعة.",
        "in:تمام رح آخذ 3",
        "in:اسمي محمد ورقمي 0930000000",
      ],
    },
    {
      customerId: customers[0].id, ext: "fb-conv-2", status: "RESOLVED", aiState: "AI_ACTIVE", unread: 0, minutesAgo: 60 * 26,
      script: ["in:وصلني الطلب، شكرا كتير 🙏", "ai:بالتوفيق وأي وقت تحتاج شي أنا موجود 🌹"],
    },
    {
      customerId: customers[1].id, ext: "fb-conv-3", status: "OPEN", aiState: "HUMAN_ACTIVE",
      unread: 1, assigned: true, minutesAgo: 15,
      script: [
        "in:عندي شكوى من الطلب الأخير، التغليف كان مكسور",
        "ai:آسفين كتير على هالمشكلة، رح أحولك مباشرة لموظف ليحلها بأسرع وقت.",
        "sys:Human takeover — AI paused (complaint detected)",
        "out:أهلًا ريم، أنا أحمد من فريق خدمة العملاء. ممكن تبعتيلي صورة للعبوة؟",
        "in:أكيد، هلق ببعتهالك",
      ],
    },
    {
      customerId: customers[2].id, ext: "fb-conv-4", status: "PENDING", aiState: "AI_ACTIVE", unread: 3, minutesAgo: 40,
      script: [
        "in:كيف أستخدم زيت الكمأة؟",
        "ai:يُضاف بعد الطهي على السلطات والمعكرونة والبيتزا 🌹 قطرات قليلة تكفي!",
        "in:وهل يناسب الأطفال؟",
      ],
    },
    {
      customerId: customers[1].id, ext: "fb-conv-5", status: "CLOSED", aiState: "AI_ACTIVE", unread: 0, minutesAgo: 60 * 24 * 5,
      script: ["in:بدي أعرف إذا يوجد تخفيضات", "ai:حاليًا ما في عروض، بس بقدر أسجل رقمك وأبلغك أول شي ينزل 🌹"],
    },
  ];

  for (const spec of specs) {
    const startAt = ago(spec.minutesAgo + spec.script.length * 2);
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: workspace.id,
        customerId: spec.customerId,
        channelId: fbChannel.id,
        channelConversationId: spec.ext,
        status: spec.status,
        aiState: spec.aiState,
        aiEnabled: spec.aiState === "AI_ACTIVE",
        unreadCount: spec.unread,
        priority: spec.priority ?? "NORMAL",
        assignedAgentId: spec.assigned ? user.id : null,
        lastCustomerMessageAt: ago(spec.minutesAgo),
        summary:
          spec.status === "RESOLVED"
            ? "عميل سابق، طلب مكتمل ومتوافق."
            : spec.aiState === "HUMAN_ACTIVE"
              ? "شكوى تغليف — بانتظار صور من العميل."
              : null,
      },
    });

    let i = 0;
    for (const line of spec.script) {
      const [kind, ...rest] = line.split(":");
      const text = rest.join(":");
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderType: kind === "in" ? "CUSTOMER" : kind === "ai" ? "AI" : kind === "sys" ? "SYSTEM" : "HUMAN",
          senderId: kind === "out" ? user.id : null,
          direction: kind === "in" ? "INBOUND" : "OUTBOUND",
          type: "TEXT",
          text,
          provider: kind === "out" ? "dashboard" : "mock",
          externalMessageId: kind === "in" ? `${spec.ext}-msg-${i}` : null,
          deliveryStatus: "DELIVERED",
          createdAt: new Date(startAt.getTime() + i * 2 * MIN),
        },
      });
      i++;
    }
  }

  // ── Channel account (encrypted demo token) + OPEN handoff — staging validation
  const { encryptSecret } = await import("../src/core/crypto");
  await prisma.channelAccount.create({
    data: {
      channelId: fbChannel.id,
      provider: "FACEBOOK",
      externalAccountId: "page-1",
      pageName: "Demo Page",
      encryptedCredentials: encryptSecret("demo-page-access-token"),
    },
  });
  await prisma.channelIdentity.create({
    data: {
      workspaceId: workspace.id,
      customerId: customers[0].id,
      channelType: "FACEBOOK",
      channelExternalId: "psid-demo-1",
    },
  });
  await prisma.humanHandoff.create({
    data: {
      workspaceId: workspace.id,
      conversationId: (
        await prisma.conversation.findFirstOrThrow({
          where: { workspaceId: workspace.id, channelConversationId: "fb-conv-3" },
        })
      ).id,
      customerId: customers[1].id,
      reason: "COMPLAINT",
      priority: "HIGH",
      status: "OPEN",
    },
  });

  // ── Order ──
  await prisma.order.create({
    data: {
      workspaceId: workspace.id,
      orderNumber: "DEMO-0001",
      customerId: customers[0].id,
      status: "CONFIRMED",
      total: 450000,
      currency: "SYP",
      province: "دمشق",
      items: {
        create: {
          productId: products[0].id,
          quantity: 3,
          unitPrice: 150000,
          subtotal: 450000,
          productNameSnapshot: products[0].name,
          skuSnapshot: "TRUFFLE-WATER-500",
        },
      },
    },
  });

  // ── Feedback (20) — 15 approved, 5 pending ──
  const feedbackSpecs = [
    { p: 0, content: "المنتج ممتاز، الطعم خيالي وكل من جربه سأل عن المصدر", rating: 5, source: "Messenger — محادثة #112" },
    { p: 0, content: "قدمته في عزيمة وكل الضيوف سألوا عنه", rating: 5, source: "Messenger — محادثة #98" },
    { p: 0, content: "وصل بسرعة والتغليف ممتاز، شكرا", rating: 5, source: "Messenger — محادثة #87" },
    { p: 0, content: "تجربة راقية، صار من ضمن ضيافي الدائمين", rating: 4, source: "Messenger — محادثة #76" },
    { p: 1, content: "العسل رائع والكمأة حقيقية مش نكهة صناعية", rating: 5, source: "Messenger — محادثة #103" },
    { p: 1, content: "أهديته لوالدتي وانبسطت كتير، والتغليف فخم", rating: 5, source: "Messenger — محادثة #91" },
    { p: 1, content: "جيد جدًا لكن كنت أتمنى برطمان أكبر", rating: 4, source: "Messenger — محادثة #84" },
    { p: 1, content: "أفضل هدية جربتها، أنصح فيه بشدة", rating: 5, source: "Messenger — محادثة #80" },
    { p: 2, content: "قطرتين على السلطة وكفى، ريحة فاخرة", rating: 5, source: "Messenger — محادثة #119" },
    { p: 2, content: "استخدمته مع الباستا، صار طبق مطعم", rating: 5, source: "Messenger — محادثة #95" },
    { p: 2, content: "جيد وحلو بس السعر غالي شوي", rating: 4, source: "Messenger — محادثة #72" },
    { p: 3, content: "المجموعة صارت هديتي الرسمية لأي مناسبة", rating: 5, source: "Messenger — محادثة #110" },
    { p: 3, content: "التوفير حقيقي والعلبة فخمة كتير", rating: 5, source: "Messenger — محادثة #101" },
    { p: 4, content: "الشاي لذيذ وهادئ، شربته بالليل وما منعني من النوم", rating: 5, source: "Messenger — محادثة #88" },
    { p: 4, content: "نكهة خفيفة ومحبوبة، رح أعيد الطلب", rating: 4, source: "Messenger — محادثة #71" },
  ];
  for (const [i, fs] of feedbackSpecs.entries()) {
    await prisma.feedback.create({
      data: {
        workspaceId: workspace.id,
        kind: "TEXT",
        productId: products[fs.p].id,
        content: fs.content,
        rating: fs.rating,
        sentiment: "positive",
        source: fs.source,
        isApproved: true,
        customerSegment: "عملاء متكررون",
      },
    });
    void i;
  }
  const pendingFeedback = [
    { p: 0, content: "بدي أعرف إذا في خصم للكمية الكبيرة", rating: null, source: "Messenger — محادثة #122" },
    { p: 1, content: "جيد بس التوصيل اتأخر يوم", rating: 3, source: "Messenger — محادثة #121" },
    { p: 2, content: "ما جربت لسا، بس حاب أسأل", rating: null, source: "Messenger — محادثة #120" },
    { p: 3, content: "هل ينفع تدفع عند الاستلام؟", rating: null, source: "Messenger — محادثة #118" },
    { p: 4, content: "وصلتني العلبة والتغليف شكلها حلو", rating: 4, source: "Messenger — محادثة #117" },
  ];
  for (const fs of pendingFeedback) {
    await prisma.feedback.create({
      data: {
        workspaceId: workspace.id,
        kind: "TEXT",
        productId: products[fs.p].id,
        content: fs.content,
        rating: fs.rating,
        sentiment: "neutral",
        source: fs.source,
        isApproved: false,
      },
    });
  }

  // ── Knowledge documents (READY + FAQ policies) ──
  const docs = [
    {
      title: "سياسة التوصيل", category: "DELIVERY" as const,
      content:
        "التوصيل متاح لجميع المحافظات السورية.\n\nالمدة: دمشق وريفها 24 ساعة، باقي المحافظات 24-48 ساعة.\n\nأجور التوصيل: 50 ألف ل.س داخل دمشق، وتُحدد حسب المحافظة لباقي المناطق.\n\nالدفع عند الاستلام متاح لجميع الطلبات.\n\nفي حال تأخر الطلب أكثر من 48 ساعة، يحق للعميل إلغاء الطلب مجانًا.",
      status: "READY" as const,
    },
    {
      title: "سياسة الاستبدال والإرجاع", category: "POLICY" as const,
      content:
        "يمكن استبدال أي منتج خلال 7 أيام من الاستلام إذا كان له عيب مصنعي.\n\nالمنتجات المفتوحة أو المستخدمة غير قابلة للإرجاع إلا في حال وجود عيب.\n\nفي حال وصول الطلب مكسورًا، يُرجى إرسال صورة للعبوة فورًا وسنستبدله مجانًا.",
      status: "READY" as const,
    },
    {
      title: "معلومات الدفع", category: "PAYMENT" as const,
      content:
        "طرق الدفع المتاحة: الدفع عند الاستلام (نقدًا)، والتحويل عبر المكاتب المالية.\n\nلا نطلب أي دفع مقدام عبر روابط أو حسابات شخصية — أي طلب كهذا هو احتيال.",
      status: "READY" as const,
    },
    {
      title: "عن الشركة", category: "COMPANY" as const,
      content:
        "نحن متجر متخصص بمنتجات الكمأة الفاخرة منذ 2019.\n\nنوفّر منتجات أصلية مع تحليل مخبري لدفاتر العسل، وتغليف هدايا مجاني، وخدمة عملاء على مدار اليوم عبر فيسبوك.\n\nمقرنا دمشق — دويلعة، والتوصيل لكل المحافظات.",
      status: "READY" as const,
    },
    {
      title: "دليل استخدام منتجات الكمأة", category: "PRODUCT" as const,
      content:
        "ماء الكمأة: يُقدم مثلجًا كمشروب ضيافة فاخر.\n\nعسل الكمأة: للفطور مع الجبن أو على التوست. لا يُسخن على نار مباشرة.\n\nزيت الكمأة: يُضاف بعد الطهي فقط — على السلطات والمعكرونة والبيتزا. قطرات قليلة تكفي.\n\nشاي الكمأة: كيس لكل كوب بماء ساخن غير مغلي لمدة 3-5 دقائق.",
      status: "READY" as const,
    },
  ];
  for (const d of docs) {
    await prisma.knowledgeDocument.create({
      data: { workspaceId: workspace.id, title: d.title, category: d.category, sourceType: "MANUAL", content: d.content, status: d.status },
    });
  }

  // Global FAQs (workspace-level, no product)
  await prisma.faq.createMany({
    data: [
      { workspaceId: workspace.id, question: "هل يوجد توصيل لكل المحافظات؟", answer: "نعم، التوصيل متاح لجميع المحافظات خلال 24-48 ساعة.", category: "DELIVERY" },
      { workspaceId: workspace.id, question: "كيف أدفع؟", answer: "الدفع عند الاستلام نقدًا أو عبر المكاتب المالية.", category: "PAYMENT" },
      { workspaceId: workspace.id, question: "هل الدفع مقدما مطلوب؟", answer: "لا، الدفع عند الاستلام. لا نطلب أي تحويل مقدم عبر روابط.", category: "PAYMENT" },
      { workspaceId: workspace.id, question: "وين محلكم؟", answer: "مقرنا دمشق — دويلعة، ونوصل لكل المحافظات.", category: "COMPANY" },
    ],
  });

  console.log("Seed complete. Demo login:", DEMO_EMAIL, "/", DEMO_PASSWORD);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
