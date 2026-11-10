/**
 * DOES THE CUSTOMER'S OWN MESSAGE ASK FOR A PICTURE?
 *
 * The entities the extractor found are one signal; the customer's raw
 * words are the other. «ورجيني ياه» carries no entity at all, and an
 * entity can match a word the customer never wrote («صور» inside a
 * longer word is not a request). Both are checked, after the same
 * Arabic normalisation the consent guard uses:
 *   أ/إ/آ → ا · ة → ه · ى → ي · tashkeel and tatweel removed.
 */

export function normalizeMediaArabic(text: string): string {
  return text
    .replace(/[ً-ْٰ]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

/** Image-asking phrases, normalised with `normalizeMediaArabic`. */
const IMAGE_PHRASES = [
  "صوره",
  "صور",
  "شكل",
  "شكله",
  "وريني",
  "ورجيني",
  "فرجيني",
  "ورني",
  "فرجنا",
  "منظر",
  "منظره",
  "بدي اشوف",
  "بدي اشوفه",
  "بدي شوفه",
  "ابعتلي ياه",
  "ابعتلي صوره",
  "كيف شكله",
  "كيف يبدو",
  // English / mixed requests (Facebook pages get both languages).
  "photo",
  "photos",
  "picture",
  "pictures",
  "pic",
  "pics",
  "image",
  "images",
  "send me a photo",
  "send me a picture",
  "send a picture",
  "send pics",
  "send photos",
  "see a picture",
  "see the picture",
  "show me the image",
  "show me the photo",
  "look like",
].map(normalizeMediaArabic);

/** Video-asking phrases, normalised with `normalizeMediaArabic`. */
const VIDEO_PHRASES = ["فيديو", "فديو"].map(normalizeMediaArabic);

function containsPhrase(normalised: string, phrase: string): boolean {
  // Token edges, not substring: «متصور» is not asking for «صور».
  // The «ال» prefix does not hide the word: «الصوره» asks for «صوره»,
  // «ابعتلي الصوره» asks for «ابعتلي صوره».
  const words = normalised
    .split(/[\s،,.!؟?؛:()«»"'—–-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/^ال/, ""));
  if (phrase.includes(" ")) {
    const bare = ` ${normalised.replace(/(^|\s)ال(\S)/g, "$1$2")} `;
    return bare.includes(` ${phrase} `);
  }
  return words.includes(phrase);
}

/** Words that ask for more than one photo, normalised like the rest. */
const PLURAL_IMAGE_PHRASES = ["صور", "photos", "pictures", "pics", "images"].map(normalizeMediaArabic);

/** «ابعتلي صور» / "send me photos": more than one photo is wanted. */
export function wantsMultipleImages(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normalizeMediaArabic(text);
  return PLURAL_IMAGE_PHRASES.some((p) => containsPhrase(t, p));
}

export type MediaAsk = "image" | "video" | null;

/** What the customer's own message asks for — image, video, or nothing. */
export function wantsMedia(text: string | null | undefined): MediaAsk {
  if (!text) return null;
  // «بأي شكل» / «على شكل دفعات» use «شكل» as "way/form", not "appearance".
  const t = normalizeMediaArabic(text).replace(/(^|\s)(?:باي|علي)\s+شكل(?=\s|$|[؟?!.,،])/g, "$1");
  if (VIDEO_PHRASES.some((p) => containsPhrase(t, p))) return "video";
  if (IMAGE_PHRASES.some((p) => containsPhrase(t, p))) return "image";
  return null;
}
