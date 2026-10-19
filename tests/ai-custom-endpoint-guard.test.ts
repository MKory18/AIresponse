import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCustomEndpointResolves,
  isCustomPrivateNetworkAllowed,
  validateCustomEndpoint,
} from "@/modules/ai/endpoint-guard";

const lookupPrivate = async () => [{ address: "192.168.3.11", family: 4 as const }];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mزوّد مخصص — سماح الشبكة الداخلية (اختيار من بيئة الخادم فقط)", () => {
  it("بلا متغير بيئة = صارم كما was", () => {
    expect(isCustomPrivateNetworkAllowed()).toBe(false);
    expect(validateCustomEndpoint("http://192.168.1.20:11434/v1")).toEqual({
      ok: false,
      reason: "IP_NOT_GLOBAL_UNICAST",
    });
  });

  it("env تفعيل AI_CUSTOM_ALLOW_PRIVATE_NETWORK=true يسمح المحلي/الـ LAN", () => {
    vi.stubEnv("AI_CUSTOM_ALLOW_PRIVATE_NETWORK", "true");
    expect(isCustomPrivateNetworkAllowed()).toBe(true);
    const opts = { allowPrivateNetwork: isCustomPrivateNetworkAllowed() };
    expect(validateCustomEndpoint("http://192.168.1.20:11434/v1", opts)).toEqual({ ok: true });
    expect(validateCustomEndpoint("http://127.0.0.1:8000/v1", opts)).toEqual({ ok: true });
  });

  it("بيانات الميتا محجوبة حتّى مع السماح", () => {
    vi.stubEnv("AI_CUSTOM_ALLOW_PRIVATE_NETWORK", "1");
    expect(
      validateCustomEndpoint("http://169.254.169.254/latest/meta-data/", {
        allowPrivateNetwork: isCustomPrivateNetworkAllowed(),
      })
    ).toEqual({ ok: false, reason: "IP_NOT_GLOBAL_UNICAST" });
  });

  it("طبقة DNS: بلا سماح = رفض عنوان شبكة حِلّ", async () => {
    const strict = await assertCustomEndpointResolves("https://lan-api.example.com/v1", { lookupFn: lookupPrivate, allowPrivateNetwork: false });
    expect(strict).toEqual({ ok: false, reason: "DNS_NOT_GLOBAL_UNICAST" });
    vi.stubEnv("AI_CUSTOM_ALLOW_PRIVATE_NETWORK", "yes");
    const allowed = await assertCustomEndpointResolves("https://lan-api.example.com/v1", { lookupFn: lookupPrivate, allowPrivateNetwork: isCustomPrivateNetworkAllowed() });
    expect(allowed).toEqual({ ok: true });
  });
});
