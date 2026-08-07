import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/stats.js", import.meta.url), "utf8");
const A = new Function(src + "\nreturn ArchiveStats;")();

// Archive rows as the worker returns them: detail is a JSON string, or null.
const row = (o) => ({ id: o.id || "e0", kind: o.kind, player_id: o.player_id || null, at: o.at || 0,
  period: o.period || 1, secs: o.secs || 0, detail: o.detail === undefined ? null : JSON.stringify(o.detail) });
const goal = (id, who, d, extra) => row({ id, kind: "goal", player_id: who, detail: { side: "us", d, ...extra }, ...extra });
const sog = (id, who, correction) => row({ id, kind: "sog", player_id: who, detail: correction ? { correction: true } : {} });

test("detailOf: null, malformed and absent details are an empty object, never a throw", () => {
  assert.deepEqual(A.detailOf({ detail: null }), {});
  assert.deepEqual(A.detailOf({ detail: "{not json" }), {});
  assert.deepEqual(A.detailOf({}), {});
  assert.deepEqual(A.detailOf({ detail: "null" }), {});
  assert.deepEqual(A.detailOf({ detail: '{"d":1}' }), { d: 1 });
});

test("rollupEvents: goals, assists and shots per player", () => {
  const by = A.rollupEvents([
    goal("e1", "p0", 1, { assistId: "p1" }),
    goal("e2", "p0", 1),
    sog("e3", "p1"),
    sog("e4", "p1"),
    sog("e5", "p0"),
  ]);
  assert.deepEqual(by.p0, { goals: 2, shots: 1, assists: 0 });
  assert.deepEqual(by.p1, { goals: 0, shots: 2, assists: 1 });
});

// The log is append-only — an undo is another row, never a deletion.
test("rollupEvents: an undone goal nets to zero, and takes its assist with it", () => {
  const by = A.rollupEvents([
    goal("e1", "p0", 1, { assistId: "p1" }),
    goal("e2", "p0", -1, { assistId: "p1" }),
  ]);
  assert.equal(by.p0.goals, 0);
  assert.equal(by.p1.assists, 0);
});

test("rollupEvents: an undone shot nets to zero", () => {
  const by = A.rollupEvents([sog("e1", "p0"), sog("e2", "p0", true)]);
  assert.equal(by.p0.shots, 0);
});

test("rollupEvents: team goals carry no player and reach nobody's record", () => {
  const by = A.rollupEvents([
    row({ id: "e1", kind: "goal", player_id: null, detail: { side: "us", d: 1 } }),
    row({ id: "e2", kind: "goal", player_id: null, detail: { side: "them", d: 1 } }),
  ]);
  assert.deepEqual(by, {}, "the games table holds the team score, not the players");
});

test("rollupEvents: only goals and shots count — subs, keeper swaps and clocks do not", () => {
  const by = A.rollupEvents([
    row({ id: "e1", kind: "sub", player_id: "p0", detail: { out: "p1" } }),
    row({ id: "e2", kind: "keeper", player_id: "p0", detail: { out: "p1" } }),
    row({ id: "e3", kind: "period", player_id: null, detail: { ended: 1 } }),
    row({ id: "e4", kind: "clock", player_id: "p0", detail: { running: true } }),
  ]);
  assert.deepEqual(by, {});
});

test("rollupEvents: an empty or missing log is an empty rollup", () => {
  assert.deepEqual(A.rollupEvents([]), {});
  assert.deepEqual(A.rollupEvents(null), {});
  assert.deepEqual(A.rollupEvents(undefined), {});
});

test("withTimeFixes: a corrected goal moves, is flagged, and the correction row is hidden", () => {
  const evs = [
    row({ id: "g1", kind: "goal", player_id: "p0", period: 1, secs: 500, at: 1, detail: { side: "us", d: 1 } }),
    row({ id: "c1", kind: "goal_time", period: 1, secs: 0, at: 2, detail: { ofEvent: "g1", period: 2, secs: 300 } }),
  ];
  const out = A.withTimeFixes(evs);
  assert.equal(out.length, 1, "the correction row is not shown itself");
  assert.equal(out[0].id, "g1");
  assert.equal(out[0].period, 2);
  assert.equal(out[0].secs, 300);
  assert.equal(out[0].moved, true);
});

test("withTimeFixes: the correction does not mutate the row it came from", () => {
  const g = row({ id: "g1", kind: "goal", period: 1, secs: 500, at: 1, detail: { side: "us", d: 1 } });
  A.withTimeFixes([g, row({ id: "c1", kind: "goal_time", at: 2, detail: { ofEvent: "g1", period: 3, secs: 60 } })]);
  assert.equal(g.period, 1, "the cached archive row is left as the server sent it");
  assert.equal(g.secs, 500);
  assert.equal(g.moved, undefined);
});

test("withTimeFixes: match order — period up, clock down, then arrival", () => {
  const evs = [
    row({ id: "a", kind: "sog", period: 2, secs: 400, at: 5 }),
    row({ id: "b", kind: "sog", period: 1, secs: 100, at: 2 }),
    row({ id: "c", kind: "sog", period: 1, secs: 600, at: 1 }),
    row({ id: "d", kind: "sog", period: 1, secs: 100, at: 9 }),
  ];
  assert.deepEqual(A.withTimeFixes(evs).map((e) => e.id), ["c", "b", "d", "a"]);
});

test("withTimeFixes: a correction naming an event that isn't there changes nothing", () => {
  const evs = [
    row({ id: "g1", kind: "goal", period: 1, secs: 500, at: 1, detail: { side: "us", d: 1 } }),
    row({ id: "c1", kind: "goal_time", at: 2, detail: { ofEvent: "gone", period: 4, secs: 10 } }),
  ];
  const out = A.withTimeFixes(evs);
  assert.equal(out.length, 1);
  assert.equal(out[0].period, 1);
  assert.equal(out[0].moved, undefined);
});

test("withTimeFixes: the last correction wins when a goal is re-timed twice", () => {
  const evs = [
    row({ id: "g1", kind: "goal", period: 1, secs: 500, at: 1, detail: { side: "us", d: 1 } }),
    row({ id: "c1", kind: "goal_time", at: 2, detail: { ofEvent: "g1", period: 2, secs: 300 } }),
    row({ id: "c2", kind: "goal_time", at: 3, detail: { ofEvent: "g1", period: 3, secs: 120 } }),
  ];
  const out = A.withTimeFixes(evs);
  assert.equal(out.length, 1);
  assert.equal(out[0].period, 3);
  assert.equal(out[0].secs, 120);
});

test("withTimeFixes: a corrected goal still counts once in the rollup", () => {
  const evs = [
    goal("g1", "p0", 1),
    row({ id: "c1", kind: "goal_time", at: 2, detail: { ofEvent: "g1", period: 2, secs: 300 } }),
  ];
  assert.equal(A.rollupEvents(evs).p0.goals, 1, "re-timing a goal is not scoring another one");
});
