import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

/* The team-passphrase gate. The mock matches on SQL text rather than argument
   position (worker.test.mjs's positional stand-in cannot survive two different
   UPDATE shapes against the same table). */
function makeD1() {
  const rows = new Map();
  return {
    _rows: rows,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this; },
        async first() {
          const r = rows.get(this.args[this.args.length - 1]);
          return r ? { ...r } : null;
        },
        async run() {
          if (/UPDATE teams SET pass_hash = NULL/.test(sql)) {
            const r = rows.get(this.args[0]);
            if (r) r.pass_hash = null;
          } else if (/UPDATE teams SET pass_hash = \?/.test(sql)) {
            const r = rows.get(this.args[1]);
            if (r) r.pass_hash = this.args[0];
          } else {
            const [id, doc, rev, updated_at, created_at] = this.args;
            const ex = rows.get(id);
            rows.set(id, ex ? { ...ex, doc, rev, updated_at } : { id, doc, rev, updated_at, created_at, pass_hash: null });
          }
          return { success: true };
        },
        async all() { return { results: [] }; },
      };
    },
  };
}

const env = () => ({ DB: makeD1() });
const req = (path, opts) => new Request("http://t" + path, opts);
const ID = "abc123def456", ID2 = "zzz999yyy888";
const DOC = JSON.stringify({ roster: [{ id: "s0", name: "Oliver" }] });
const PASS = "sideline26";

const jsonReq = (path, method, body, cookie) => req(path, {
  method,
  headers: cookie
    ? { "content-type": "application/json", cookie }
    : { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Create the team the way the app does, then read back the Set-Cookie a login mints.
async function seed(e, id = ID) {
  await worker.fetch(jsonReq(`/api/team/${id}`, "PUT", { doc: DOC, baseRev: 0 }), e);
}
async function setPass(e, id = ID, pass = PASS, cookie) {
  const r = await worker.fetch(jsonReq(`/api/team/${id}/auth`, "POST", { newPass: pass }, cookie), e);
  return { status: r.status, cookie: sessionOf(r) };
}
// "cs_<id>=<v>; Max-Age=...; Path=/api; ..." -> "cs_<id>=<v>" for a Cookie header
const sessionOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

test("a team with no passphrase is readable with no cookie (nothing changes for existing links)", async () => {
  const e = env();
  await seed(e);
  const r = await worker.fetch(req(`/api/team/${ID}`), e);
  assert.equal(r.status, 200);

  const s = await (await worker.fetch(req(`/api/team/${ID}/auth`), e)).json();
  assert.deepEqual(s, { exists: true, locked: false, authed: true });
});

test("setting a passphrase locks the team against a cookieless caller", async () => {
  const e = env();
  await seed(e);
  const { status, cookie } = await setPass(e);
  assert.equal(status, 200);
  assert.ok(cookie.startsWith(`cs_${ID}=`), "a session cookie comes back with the lock");

  const open = await worker.fetch(req(`/api/team/${ID}`), e);
  assert.equal(open.status, 401);
  assert.equal((await open.json()).error, "locked");

  const withCookie = await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie } }), e);
  assert.equal(withCookie.status, 200);
  assert.equal((await withCookie.json()).doc, DOC);
});

test("the archive routes are gated too, not just the doc", async () => {
  const e = env();
  await seed(e);
  const { cookie } = await setPass(e);
  for (const p of [`/api/team/${ID}/games`, `/api/team/${ID}/stats`, `/api/team/${ID}/positions`]) {
    assert.equal((await worker.fetch(req(p), e)).status, 401, `${p} must be gated`);
  }
  assert.equal((await worker.fetch(req(`/api/team/${ID}/games`, { headers: { cookie } }), e)).status, 200);
});

test("login: right passphrase mints a session, wrong one is 401 with no cookie", async () => {
  const e = env();
  await seed(e);
  await setPass(e);

  const bad = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: "not it" }), e);
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, "bad_passphrase");
  assert.equal(bad.headers.get("set-cookie"), null);

  // Phones add trailing spaces; the server trims so that never locks a coach out.
  const good = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: `  ${PASS} ` }), e);
  assert.equal(good.status, 200);
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie: sessionOf(good) } }), e)).status, 200);
});

test("the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to /api", async () => {
  const e = env();
  await seed(e);
  const r = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: PASS }), e);
  const c = r.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api"]) {
    assert.ok(c.includes(attr), `missing ${attr} in ${c}`);
  }
});

test("one team's session does not open another team", async () => {
  const e = env();
  await seed(e); await seed(e, ID2);
  const a = await setPass(e, ID, PASS);
  await setPass(e, ID2, "different1");

  // Same signed value, re-labelled for the other team: the id is inside the
  // signature and the key is that team's own hash, so it cannot verify.
  const forged = `cs_${ID2}=` + a.cookie.split("=")[1];
  assert.equal((await worker.fetch(req(`/api/team/${ID2}`, { headers: { cookie: forged } }), e)).status, 401);
});

test("a tampered or expired session is refused", async () => {
  const e = env();
  await seed(e);
  const { cookie } = await setPass(e);
  const [name, val] = [cookie.split("=")[0], cookie.split("=")[1]];
  const [exp, sig] = val.split(".");

  const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie: `${name}=${exp}.${flipped}` } }), e)).status, 401);

  // Pushing the expiry out invalidates the signature; it is signed over too.
  const later = Date.now() + 400 * 24 * 3600 * 1000;
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie: `${name}=${later}.${sig}` } }), e)).status, 401);

  const past = Date.now() - 1000;
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie: `${name}=${past}.${sig}` } }), e)).status, 401);
});

test("holding the link sets the FIRST passphrase; changing it needs the current one", async () => {
  const e = env();
  await seed(e);
  await setPass(e);   // bootstrap with no cookie: the link was the credential

  const noCred = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: "hijacked1" }), e);
  assert.equal(noCred.status, 401);

  const withPass = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: PASS, newPass: "rotated123" }), e);
  assert.equal(withPass.status, 200);
  assert.equal((await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: "rotated123" }), e)).status, 200);
});

test("changing the passphrase invalidates every existing session", async () => {
  const e = env();
  await seed(e);
  const { cookie } = await setPass(e);
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie } }), e)).status, 200);

  await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: "rotated123" }, cookie), e);
  assert.equal((await worker.fetch(req(`/api/team/${ID}`, { headers: { cookie } }), e)).status, 401,
    "the old device must be logged out — the hash is the signing key");
});

test("removing the passphrase reopens the team to the link alone", async () => {
  const e = env();
  await seed(e);
  const { cookie } = await setPass(e);
  const off = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: null }, cookie), e);
  assert.equal(off.status, 200);
  assert.equal((await off.json()).locked, false);
  assert.equal((await worker.fetch(req(`/api/team/${ID}`), e)).status, 200);
});

test("a too-short passphrase is refused and the team stays as it was", async () => {
  const e = env();
  await seed(e);
  const r = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: "abc" }), e);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "bad_passphrase_length");
  assert.equal((await worker.fetch(req(`/api/team/${ID}`), e)).status, 200, "still unlocked");
});

test("auth on a team that does not exist yet is 404, not a lock", async () => {
  const e = env();
  const r = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { newPass: PASS }), e);
  assert.equal(r.status, 404);
  const s = await (await worker.fetch(req(`/api/team/${ID}/auth`), e)).json();
  assert.equal(s.exists, false);
  assert.equal(s.locked, false);
});

test("the rate limiter short-circuits a login before any hashing happens", async () => {
  const e = env();
  await seed(e);
  await setPass(e);

  let dbHits = 0;
  const counting = { ...e, DB: { prepare: (sql) => { dbHits++; return e.DB.prepare(sql); } } };
  counting.LOGIN_LIMIT = { limit: async () => ({ success: false }) };

  const r = await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: PASS }), counting);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(dbHits, 0, "429 must cost neither a D1 read nor a key derivation");
});

test("a passing rate limiter does not get in the way", async () => {
  const e = env();
  await seed(e);
  await setPass(e);
  e.LOGIN_LIMIT = { limit: async () => ({ success: true }) };
  assert.equal((await worker.fetch(jsonReq(`/api/team/${ID}/auth`, "POST", { pass: PASS }), e)).status, 200);
});

test("API responses carry nosniff", async () => {
  const r = await worker.fetch(req("/api/health"), env());
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
