import { describe, expect, it } from "vitest";
import { wantsMedia } from "@/modules/media/request";

describe("wantsMedia: «شكل» inside an idiom is not an image request", () => {
  it.each(["بأي شكل", "ما بدي اياه بأي شكل", "بدي ادفع على شكل دفعات", "على شكل كبسولات؟"])(
    "%s → no media",
    (text) => {
      expect(wantsMedia(text)).toBeNull();
    }
  );

  it.each(["شكل", "شكله", "كيف شكله", "ابعتلي صور"])("%s → still an image request", (text) => {
    expect(wantsMedia(text)).toBe("image");
  });
});
