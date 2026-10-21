import { describe, expect, it } from "vitest";
import { normalizeMediaArabic, wantsMedia } from "@/modules/media/request";

/**
 * THE CUSTOMER'S OWN WORDS ARE A SIGNAL, NOT ONLY THE ENTITIES.
 *
 * «ورجيني ياه» carries no entity; an entity can match a word never
 * written. Every required phrase must be caught, every near-miss refused.
 */
describe("wantsMedia — dialect phrases", () => {
  const imageCases = [
    "صوره",
    "صورة",
    "صور",
    "شكل",
    "شكله",
    "وريني",
    "ورجيني",
    "فرجيني",
    "بدي اشوف",
    "ابعتلي ياه",
    "ابعتلي صوره",
    "كيف شكله",
    "كيف يبدو",
    "ممكن تبعتلي صورة المنتج؟",
    "وَرّيني شكله", // tashkeel is stripped before matching
    "الصوره", // ال prefix does not hide the word
    "موجود منظره؟",
    "بدي اشوفه",
    "ورني الصورة",
    // English and mixed requests are common on Facebook pages.
    "send me a photo",
    "can I see a picture?",
    "send pics please",
    "what does it look like",
    "show me the image",
  ];
  it.each(imageCases)("image: %s", (text) => {
    expect(wantsMedia(text)).toBe("image");
  });

  const videoCases = ["فيديو", "فديو", "ابعتلي فيديو", "في فيديو للمنتج؟"];
  it.each(videoCases)("video: %s", (text) => {
    expect(wantsMedia(text)).toBe("video");
  });

  const negatives = [
    "",
    "بكم السعر؟",
    "متصور مع المنتج", // «صور» inside a longer word is not a request
    "صورني", // suffix glued to the word is not a request
    "التوصيل خلال يومين",
    "شكرا",
    "send me the price",
    "كم سعر الصندوق؟",
  ];
  it.each(negatives)("nothing: %s", (text) => {
    expect(wantsMedia(text)).toBeNull();
  });

  it("null and undefined ask for nothing", () => {
    expect(wantsMedia(null)).toBeNull();
    expect(wantsMedia(undefined)).toBeNull();
  });
});

describe("normalizeMediaArabic", () => {
  it("unifies alef forms, ta marbuta, alef maqsura, tashkeel and tatweel", () => {
    expect(normalizeMediaArabic("إبـعـتـلي صـورَةً")).toBe("ابعتلي صوره");
    expect(normalizeMediaArabic("كَيْفَ شَكْلُه")).toBe("كيف شكله");
    expect(normalizeMediaArabic("ورجينى")).toBe("ورجيني");
  });
});
