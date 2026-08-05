import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

// Minimal in-memory stand-in for the D1 binding: enough of prepare/bind/first/run
// to exercise the worker's real SQL calls (SELECT by id, INSERT ... ON CONFLICT).
function makeD1() {
  const rows = new Map();
  return {
    _rows: rows,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this; },
        async first() {
          const r = rows.get(this.args[0]);
          return r ? { ...r } : null;
        },
        async run() {
          const [id, doc, rev, updated_at, created_at] = this.args;
          const ex = rows.get(id);
          rows.set(id, ex ? { ...ex, doc, rev, updated_at } : { id, doc, rev, updated_at, created_at });
          return { success: true };
        },
      };
    },
  };
}

const env = () => ({ DB: makeD1() });
const req = (path, opts) => new Request("http://t" + path, opts);
const ID = "abc123def456"; // valid: [A-Za-z0-9_-]{8,64}
const DOC = JSON.stringify({ roster: [{ id: "s0", name: "Oliver" }], periods: 4 });

test("health reports the app name", async () => {
  const r = await worker.fetch(req("/api/health"), env());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).app, "coach-sideline");
});

test("PUT creates a team at rev 1, GET returns it", async () => {
  const e = env();
  let r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rev, 1);

  r = await worker.fetch(req(`/api/team/${ID}`), e);
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.equal(g.rev, 1);
  assert.equal(g.doc, DOC);
});

test("stale baseRev conflicts (409) and returns current doc", async () => {
  const e = env();
  await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e); // now rev 1
  const r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }), // stale
  }), e);
  assert.equal(r.status, 409);
  const c = await r.json();
  assert.equal(c.rev, 1);
  assert.equal(c.doc, DOC);
});

test("correct baseRev advances the rev", async () => {
  const e = env();
  await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e);
  const r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 1 }),
  }), e);
  assert.equal((await r.json()).rev, 2);
});

test("?force=1 overwrites despite a stale baseRev", async () => {
  const e = env();
  await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e); // rev 1
  const r = await worker.fetch(req(`/api/team/${ID}?force=1`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rev, 2);
});

test("rejects a bad team id", async () => {
  const r = await worker.fetch(req("/api/team/short", { method: "GET" }), env());
  assert.equal(r.status, 400);
});

test("rejects an invalid JSON body", async () => {
  const r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: "{not json",
  }), env());
  assert.equal(r.status, 400);
});

test("rejects a doc that isn't a JSON string", async () => {
  const r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: "this is not json" }),
  }), env());
  assert.equal(r.status, 400);
});

test("unknown api path 404s, wrong method 405s", async () => {
  assert.equal((await worker.fetch(req("/api/nope"), env())).status, 404);
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { method: "DELETE" }), env())).status, 405);
});

/* ---------- web push: VAPID (RFC 8292) ---------- */
// The signature is the whole security story of a payload-less push, so it gets
// verified against the public key the header advertises, not just eyeballed.
import { vapidAuth } from "../src/worker.js";

const b64uToBytes = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(t + "=".repeat((4 - (t.length % 4)) % 4), "base64");
};

async function vapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { env: { VAPID_PRIVATE_JWK: JSON.stringify(jwk), VAPID_SUBJECT: "mailto:coach@example.com" }, kp };
}

test("vapidAuth signs a JWT that verifies against the advertised public key", async () => {
  const { env } = await vapidEnv();
  const { auth, pub } = await vapidAuth(env, "https://web.push.apple.com/abc123");

  const m = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, "header must be `vapid t=<jwt>, k=<pubkey>`");
  assert.equal(m[2], pub);

  const [head, body, sig] = m[1].split(".");
  const pubKey = await crypto.subtle.importKey(
    "raw", b64uToBytes(pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, pubKey,
    b64uToBytes(sig), new TextEncoder().encode(head + "." + body)
  );
  assert.equal(ok, true, "signature must verify with the key in the k= parameter");
});

test("vapidAuth scopes the token to the push service origin and expires within 24h", async () => {
  const { env } = await vapidEnv();
  const { auth } = await vapidAuth(env, "https://fcm.googleapis.com/fcm/send/xyz?a=1");
  const claims = JSON.parse(b64uToBytes(auth.split(" ")[1].slice(2, -1).split(".")[1]).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com", "aud is the origin only, no path");
  assert.equal(claims.sub, "mailto:coach@example.com");
  const ttl = claims.exp - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 0 && ttl <= 24 * 3600, `exp must be inside the spec's 24h window, got ${ttl}s`);
});
