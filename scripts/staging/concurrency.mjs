/**
 * Concurrency suite — REAL HTTP + REAL PostgreSQL (staging).
 * Usage:
 *   BASE_URL=http://localhost:3000 META_APP_SECRET=<from .env> \
 *   node scripts/staging/concurrency.mjs
 *
 * Requires the demo seed (npm run db:seed): it provides the Facebook page
 * (page-1), a customer identity (psid-demo-1) and an OPEN handoff.
 *
 * Scenarios (Phase 9 §9):
 *  1. 100 concurrent identical webhook deliveries → 1 WebhookEvent/Message
 *  2. 100 concurrent confirmations of the same draft → 1 order
 *  3. 100 concurrent handoff claims → 1 winner (409 for the rest)
 * Reports p50/p95/p99 + error rate per scenario. Exit 1 on any FAIL.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const APP_SECRET = process.env.META_APP_SECRET ?? "";
const PAGE_ID = process.env.STAGING_PAGE_ID ?? "page-1";
const EMAIL = process.env.STAGING_EMAIL ?? `staging-${Date.now()}@test.local`;
const PASSWORD = process.env.STAGING_PASSWORD ?? "Staging#2026!";

let cookie = "";
async function api(method, path, body, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const ms = performance.now() - t0;
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, ms };
}

const pct = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
function report(name, times, okCount, total, passCondition) {
  const pass = passCondition ?? okCount === total;
  console.log(
    `${pass ? "PASS" : "FAIL"}: ${name} — ok=${okCount}/${total} ` +
    `p50=${pct(times, 50).toFixed(0)}ms p95=${pct(times, 95).toFixed(0)}ms p99=${pct(times, 99).toFixed(0)}ms`
  );
  if (!pass) process.exitCode = 1;
}

let failures = 0;
function check(name, pass, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!pass) failures += 1;
}

// ── auth ────────────────────────────────────────────────────────────────────
{
  const r = await api("POST", "/api/auth/register", {
    name: "Staging Runner", email: EMAIL, password: PASSWORD, workspaceName: "Concurrency WS",
  });
  check("auth: register", r.status === 201 || r.status === 409, `status ${r.status}`);
  const me = await api("GET", "/api/auth/me");
  check("auth: session/me", me.status === 200 && me.json?.user?.email === EMAIL);
}

// ── webhook replay ×100 (signed, identical payload) ─────────────────────────
if (!APP_SECRET) {
  console.log("SKIP: webhook replay (META_APP_SECRET not set)");
  failures += 1;
} else {
  const crypto = await import("node:crypto");
  const payload = {
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: Date.now(),
      messaging: [{
        sender: { id: "psid-demo-1" },
        recipient: { id: PAGE_ID },
        timestamp: Date.now(),
        message: { mid: `stg-replay-${Date.now()}`, text: "رسالة اختبار ستاجينغ" },
      }],
    }],
  };
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");

  const times = [];
  let accepted = 0, duplicates = 0, rejected = 0;
  const results = await Promise.all(
    Array.from({ length: 100 }, async () => {
      const t0 = performance.now();
      const res = await fetch(`${BASE}/api/webhooks/meta`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hub-signature-256": sig },
        body: raw,
      });
      times.push(performance.now() - t0);
      const j = await res.json().catch(() => ({}));
      if (res.status === 401) rejected += 1;
      else if (j.duplicate) duplicates += 1;
      else if (res.ok) accepted += 1;
      return res.status;
    })
  );
  void results;
  report("webhook replay ×100 (all 200 fast)", times, accepted + duplicates, 100);
  check("webhook replay: exactly 1 accepted", accepted === 1, `accepted=${accepted} duplicates=${duplicates} rejected=${rejected}`);

  // webhook latency: must be fast (no AI inside)
  check("webhook latency p95 < 2000ms", pct(times, 95) < 2000, `p95=${pct(times, 95).toFixed(0)}ms`);
}

// ── 100 concurrent handoff claims → 1 winner ────────────────────────────────
{
  const list = await api("GET", "/api/handoffs?status=OPEN");
  const handoff = list.json?.items?.[0];
  if (!handoff) {
    console.log("SKIP: handoff claim race (no OPEN handoff in seed)");
    failures += 1;
  } else {
    const times = [];
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const r = await api("POST", `/api/handoffs/${handoff.id}`, { action: "claim" });
        times.push(r.ms);
        return r.status;
      })
    );
    const winners = results.filter((s) => s === 200).length;
    const conflicts = results.filter((s) => s === 409).length;
    report("handoff claim ×100", times, winners + conflicts, 100);
    check("handoff claim: exactly 1 winner", winners === 1 && conflicts === 99, `winners=${winners} conflicts=${conflicts}`);
  }
}

// ── order confirmation race requires a READY draft — created by the pipeline.
// The seeded conversation can be driven through the playground (dry-run) to
// build the draft, then 100 concurrent confirmations are issued.
{
  const convs = await api("GET", "/api/conversations");
  const conv = convs.json?.items?.[0];
  if (!conv) {
    console.log("SKIP: order confirmation race (no conversation)");
    failures += 1;
  } else {
    // Build the draft deterministically through the pipeline (dry-run persists drafts)
    await api("POST", "/api/ai/playground", {
      conversationId: conv.id,
      simulateText: "بدي 3 من ماء الكمأة، رقمي 0930000999، عنواني دمشق دويلعة",
    });
    const drafts = await api("GET", `/api/order-drafts?conversationId=${conv.id}`);
    const draft = drafts.json?.items?.[0];
    if (!draft || draft.state !== "READY") {
      // playground dry-run creates the draft; agent confirms via confirm endpoint
      console.log("SKIP: order confirmation race (draft not READY:", draft?.state ?? "none", ")");
      failures += 1;
    } else {
      const times = [];
      const results = await Promise.all(
        Array.from({ length: 100 }, async () => {
          const r = await api("POST", `/api/order-drafts/${draft.id}/confirm`, {});
          times.push(r.ms);
          return r.status;
        })
      );
      const created = results.filter((s) => s === 201).length;
      const rejected = results.filter((s) => s === 422 || s === 409 || s === 400).length;
      report("order confirm ×100", times, created + rejected, 100);
      check("order confirm: exactly 1 created", created === 1, `created=${created} rejected=${rejected}`);
    }
  }
}

console.log(failures === 0 ? "\nCONCURRENCY SUITE: ALL PASS" : `\nCONCURRENCY SUITE: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
