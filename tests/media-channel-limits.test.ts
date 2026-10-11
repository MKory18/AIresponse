import { describe, expect, it } from "vitest";
import { mediaFitsChannel } from "@/modules/media/channel-limits";

/**
 * WHAT EACH CHANNEL CAN CARRY — ONE TABLE.
 *
 * WhatsApp: JPEG/PNG ≤ 5MB, MP4/3GPP ≤ 16MB. Meta channels (Messenger,
 * Instagram): the formats this integration emits, ≤ 25MB. Anything else
 * keeps today's pass-through — no new refusal for channels outside the
 * table.
 */
const MB = 1024 * 1024;

describe("mediaFitsChannel — WhatsApp", () => {
  it.each([
    ["image/jpeg", 5 * MB],
    ["image/png", 100],
  ])("accepts %s at %s bytes", (mimeType, size) => {
    expect(mediaFitsChannel({ type: "IMAGE", mimeType, size }, "WHATSAPP")).toEqual({ ok: true });
  });

  it.each([
    ["image/webp", 100, "UNSUPPORTED_TYPE"],
    ["image/gif", 100, "UNSUPPORTED_TYPE"],
    ["image/jpeg", 5 * MB + 1, "TOO_LARGE"],
    ["image/png", 6 * MB, "TOO_LARGE"],
  ])("refuses %s at %s bytes (%s)", (mimeType, size, reason) => {
    expect(mediaFitsChannel({ type: "IMAGE", mimeType, size }, "WHATSAPP")).toEqual({ ok: false, reason });
  });

  it.each([
    ["video/mp4", 16 * MB],
    ["video/3gpp", 100],
  ])("accepts %s at %s bytes", (mimeType, size) => {
    expect(mediaFitsChannel({ type: "VIDEO", mimeType, size }, "WHATSAPP")).toEqual({ ok: true });
  });

  it.each([
    ["video/webm", 100, "UNSUPPORTED_TYPE"],
    ["video/mp4", 17 * MB, "TOO_LARGE"],
  ])("refuses %s at %s bytes (%s)", (mimeType, size, reason) => {
    expect(mediaFitsChannel({ type: "VIDEO", mimeType, size }, "WHATSAPP")).toEqual({ ok: false, reason });
  });
});

describe("mediaFitsChannel — Meta channels", () => {
  for (const channel of ["FACEBOOK", "INSTAGRAM"]) {
    it(`${channel} accepts jpeg/png/gif images ≤ 25MB`, () => {
      expect(mediaFitsChannel({ type: "IMAGE", mimeType: "image/gif", size: 25 * MB }, channel)).toEqual({ ok: true });
      expect(mediaFitsChannel({ type: "IMAGE", mimeType: "image/webp", size: 100 }, channel)).toEqual({
        ok: false,
        reason: "UNSUPPORTED_TYPE",
      });
      expect(mediaFitsChannel({ type: "IMAGE", mimeType: "image/jpeg", size: 26 * MB }, channel)).toEqual({
        ok: false,
        reason: "TOO_LARGE",
      });
    });
  }
});

describe("mediaFitsChannel — unlisted channels", () => {
  it.each(["TELEGRAM", "TIKTOK", "WEB", "UNKNOWN"])("%s keeps pass-through", (channel) => {
    expect(mediaFitsChannel({ type: "IMAGE", mimeType: "image/webp", size: 50 * MB }, channel)).toEqual({ ok: true });
  });
});
