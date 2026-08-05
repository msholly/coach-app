import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { parseIcsEvents } from "../src/worker.js";

const TEAM = "abc123def456";
const req = (path) => new Request("http://t" + path);

// Shaped on the real GameChanger feed (PRODID -//com.gc/NONSGML GameChanger).
const ics = (events) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//com.gc/NONSGML GameChanger - Back End//EN",
   "X-WR-CALNAME:Fall 2026 BU8", "X-PUBLISHED-TTL:PT18000S", ...events, "END:VCALENDAR"].join("\r\n");

const vevent = (summary, over = {}) => [
  "BEGIN:VEVENT",
  `UID:${over.uid || "uid-1"}`,
  `DTSTART:${over.start || "20260912T170000Z"}`,
  `DTEND:${over.end || "20260912T180000Z"}`,
  `SUMMARY:${summary}`,
  `LOCATION:${over.location || "30082 Melinda Rd\\nRancho Santa Margarita North\\, CA 92688"}`,
  "END:VEVENT",
].join("\r\n");

test("home/away comes off SUMMARY; anything without a separator is not recorded", () => {
  const [home] = parseIcsEvents(ics([vevent("Fall 2026 BU8 vs Rangers")]));
  assert.equal(home.venue, "home");
  assert.equal(home.opponent, "Rangers");

  const [away] = parseIcsEvents(ics([vevent("Fall 2026 BU8 @ Sharks")]));
  assert.equal(away.venue, "away");
  assert.equal(away.opponent, "Sharks");

  // the placeholder row the real feed shipped with
  const [tbd] = parseIcsEvents(ics([vevent("Fall 2026 BU8 @ TBD")]));
  assert.equal(tbd.venue, "away");
  assert.equal(tbd.opponent, "TBD");

  // A practice has no separator. It must NOT fall through to "home" — the whole
  // point of NULL venue is that "not recorded" stays distinct from "home".
  const [practice] = parseIcsEvents(ics([vevent("Practice")]));
  assert.equal(practice.venue, null);
  assert.equal(practice.opponent, null);

  // "vs." with a period, and a team name that itself contains an @-like word
  const [dotted] = parseIcsEvents(ics([vevent("Fall 2026 BU8 vs. FC Vs Valley")]));
  assert.equal(dotted.venue, "home");
  assert.equal(dotted.opponent, "FC Vs Valley");
});

test("ICS decoding: escapes, folded lines, UTC stamps, ordering", () => {
  const [e] = parseIcsEvents(ics([vevent("Fall 2026 BU8 vs Rangers")]));
  assert.equal(e.location, "30082 Melinda Rd\nRancho Santa Margarita North, CA 92688");
  assert.equal(e.startsAt, Date.UTC(2026, 8, 12, 17, 0, 0));
  assert.equal(e.endsAt, Date.UTC(2026, 8, 12, 18, 0, 0));

  // RFC 5545 line folding: the continuation's leading space is the fold marker,
  // not content, so unfolding drops CRLF+space and the two halves join exactly.
  // A space that belongs to the text has to sit at the end of the first line.
  const folded = ics(["BEGIN:VEVENT", "UID:u", "DTSTART:20260912T170000Z",
    "SUMMARY:Fall 2026 BU8 vs Rancho Santa ", " Margarita Rangers", "END:VEVENT"]);
  assert.equal(parseIcsEvents(folded)[0].opponent, "Rancho Santa Margarita Rangers");

  // a floating (non-Z) DTSTART is left null, never guessed into a timezone
  const floating = ics(["BEGIN:VEVENT", "UID:u", "DTSTART;TZID=America/Los_Angeles:20260912T100000",
    "SUMMARY:Fall 2026 BU8 vs Rangers", "END:VEVENT"]);
  assert.equal(parseIcsEvents(floating)[0].startsAt, null);
  assert.equal(parseIcsEvents(floating)[0].venue, "home", "TZID parameter must not break SUMMARY parsing");

  const many = parseIcsEvents(ics([
    vevent("Fall 2026 BU8 vs B", { uid: "b", start: "20261001T170000Z" }),
    vevent("Fall 2026 BU8 vs A", { uid: "a", start: "20260912T170000Z" }),
  ]));
  assert.deepEqual(many.map((x) => x.uid), ["a", "b"], "sorted by start");
});

test("schedule route: 501 when the secret is absent, and the token never leaks", async () => {
  let r = await worker.fetch(req(`/api/team/${TEAM}/schedule`), {});
  assert.equal(r.status, 501);
  let body = await r.text();
  assert.match(body, /schedule_unavailable/);

  // A fetch that throws quotes the URL it was handed. That URL holds the token.
  const TOKEN = "b96edb05860d5d14afd2c914d950107f68da66d4";
  const URL_WITH_TOKEN = `https://api.team-manager.gc.com/x.ics?teamId=t&token=${TOKEN}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED " + URL_WITH_TOKEN); };
  try {
    r = await worker.fetch(req(`/api/team/${TEAM}/schedule`), { GC_ICS_URL: URL_WITH_TOKEN });
    body = await r.text();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(r.status, 502);
  assert.ok(!body.includes(TOKEN), "the bearer token must never reach the response body");
  assert.match(body, /token=\[redacted\]/);
});

test("schedule route: webcal:// is rewritten, non-https refused, non-calendar rejected", async () => {
  const realFetch = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (u) => { asked = u; return new Response(ics([vevent("Fall 2026 BU8 vs Rangers")]), { status: 200 }); };
  try {
    const r = await worker.fetch(req(`/api/team/${TEAM}/schedule`),
      { GC_ICS_URL: "webcal://api.team-manager.gc.com/x.ics?token=abc" });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.match(asked, /^https:\/\//, "webcal:// must be rewritten — fetch() cannot use that scheme");
    assert.equal(b.calendar, "Fall 2026 BU8");
    assert.equal(b.events[0].venue, "home");
    assert.equal(r.headers.get("cache-control"), "private, max-age=300",
      "a coach's schedule must never land in a shared cache");

    // an http:// or file:// secret is a misconfiguration, not something to fetch
    const bad = await worker.fetch(req(`/api/team/${TEAM}/schedule`), { GC_ICS_URL: "http://example.com/x.ics" });
    assert.equal(bad.status, 500);

    // an HTML error page from GC must not be parsed as a calendar
    globalThis.fetch = async () => new Response("<html>login</html>", { status: 200 });
    const notCal = await worker.fetch(req(`/api/team/${TEAM}/schedule`), { GC_ICS_URL: "https://x/y.ics" });
    assert.equal(notCal.status, 502);
    assert.match(await notCal.text(), /schedule_not_calendar/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
