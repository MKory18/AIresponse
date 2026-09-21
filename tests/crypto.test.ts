import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, timingSafeEqual } from "@/core/crypto";

describe("crypto", () => {
  it("round-trips secrets", () => {
    const secret = "EAAG-super-secret-page-token-123";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces unique ciphertexts (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("data");
    const [iv, tag, data] = encrypted.split(".");
    const tampered = `${iv}.${tag}.${Buffer.from("tampered").toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("timingSafeEqual works", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
