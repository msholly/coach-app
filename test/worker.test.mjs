import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

// Minimal in-memory stand-in for the D1 binding. All first() queries in the worker
// are SELECT ... WHERE id = ? (id is the first bind arg); run() dispatches on the
// statement so the conditional UPDATE / INSERT split in putTeam is exercised for real.
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
          const s = this.sql;
          if (/^\s*INSERT INTO teams/i.test(s)) {
            const [id, doc, rev, updated_at, created_at] = this.args;
            rows.set(id, { id, doc, rev, updated_at, created_at });
            return { success: true, meta: { changes: 1 } };
          }
          if (/^\s*UPDATE teams SET doc/i.test(s)) {
            const [doc, rev, updated_at, id, guardRev] = this.args;   // guardRev undefined on the unconditional form
            const ex = rows.get(id);
            if (!ex || (guardRev !== undefined && ex.rev !== guardRev)) return { success: true, meta: { changes: 0 } };
            rows.set(id, { ...ex, doc, rev, updated_at });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
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

test("baseRev:null writes unconditionally (client sent no base)", async () => {
  const e = env();
  await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e); // rev 1
  const r = await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC }), // no baseRev
  }), e);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rev, 2);
});

// C1 — the lost-write race. Two writers both read rev 5; the first UPDATE wins,
// the second's guarded UPDATE matches no row and must 409 instead of overwriting.
test("concurrent writers on the same base rev: the loser gets a 409, not a silent overwrite", async () => {
  const rows = new Map([[ID, { id: ID, doc: DOC, rev: 5, updated_at: 1, created_at: 1 }]]);
  const db = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this; },
        async first() {
          if (/SELECT rev/i.test(sql)) return { rev: 5 };   // both callers read the stale rev
          const r = rows.get(this.args[0]); return r ? { ...r } : null;
        },
        async run() {
          if (/^\s*UPDATE teams SET doc/i.test(sql)) {
            const [doc, rev, updated_at, id, guardRev] = this.args;
            const ex = rows.get(id);
            if (!ex || (guardRev !== undefined && ex.rev !== guardRev)) return { meta: { changes: 0 } };
            rows.set(id, { ...ex, doc, rev, updated_at }); return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
  const e = { DB: db };
  const put = () => worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 5 }),
  }), e);

  const r1 = await put();
  assert.equal(r1.status, 200);                 // first writer wins, rev -> 6
  const r2 = await put();
  assert.equal(r2.status, 409);                 // second read rev 5; UPDATE WHERE rev=5 matched nothing
  assert.equal((await r2.json()).rev, 6);       // and it hands back the current rev to reconcile
});

/* ---------- S1: schedule endpoint requires the team to exist ---------- */

test("schedule 404s for an unknown team id", async () => {
  const r = await worker.fetch(req(`/api/team/${ID}/schedule`), env());
  assert.equal(r.status, 404);
});

test("schedule gets past the existence check for a known team", async () => {
  const e = env();
  await worker.fetch(req(`/api/team/${ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: DOC, baseRev: 0 }),
  }), e);
  const r = await worker.fetch(req(`/api/team/${ID}/schedule`), e);
  // GC_ICS_URL is unset in the test env, so a team that DOES exist reaches the
  // config check (501) rather than being turned away as not_found (404).
  assert.equal(r.status, 501);
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
