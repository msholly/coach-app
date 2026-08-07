# Firebase as a future home — research

> 2026-08-05. Exploratory: the app doesn't need this. Framed as a learning/portfolio exercise.

**Verdict: Firestore, not Realtime Database — and don't put the ticking clock in either.**

RTDB looks like the natural fit (real-time, JSON tree, near drop-in for the one-doc-per-team
model) and it loses on one fact: **the RTDB JavaScript SDK has no disk persistence.**
`setPersistenceEnabled` exists on Android, iOS, Flutter and Admin-Java — not on web. Offline
RTDB on web is in-memory only and gone on reload. For an app whose stated premise is "a dead
signal at the field never bricks game day," that's disqualifying on its own.

---

## 1. Firestore vs Realtime Database

| | Firestore | Realtime DB |
|---|---|---|
| **Offline on web** | IndexedDB via `persistentLocalCache()`; survives reload, queues writes | **In-memory only.** No web disk persistence |
| **Queries** | Composite indexes, `where`/`orderBy` server-side | Single-child ordering; anything else = hand-maintained duplicate nodes |
| **Billing** | Per operation (read/write/delete) + cheap storage/bandwidth | Per GB stored + downloaded, no op charges |
| **Presence** | None built in (the official recipe uses RTDB for it) | `onDisconnect()` + `.info/connected` |
| **Latency** | Slightly higher | Lowest |
| **Google's own default** | Recommended | "Classic", simple data models |

Three things decide it for this app:

1. **Offline** — above. `public/outbox.js` + the localStorage-first design in `public/state.js`
   exist to solve exactly what Firestore's persistent cache does natively.
2. **Season stats** — `GET /api/team/:id/stats?season=` aggregates goals/shots per player from
   an append-only event log. That's a query. On RTDB it becomes a denormalized counter node you
   maintain by hand on every write (Firebase's own comparison doc uses precisely this example).
3. **Rules** — per-document read rules unlock the parent read-only view that's blocked today
   (the team token is currently an all-or-nothing write credential).

RTDB's `onDisconnect` is genuinely nice ("assistant coach's phone is live"). Both can run in one
Firebase project, so add it later if a presence feature ever appears. Don't pick the database for it.

---

## 2. The game day page specifically

**Do not sync the clock tick.** Sync the *state transition*, derive elapsed locally:

```js
// teams/{id}/games/{gameId}  — the only doc the game day page listens to
{ running: true, period: 2, startedAt: <serverTimestamp>, secsAtPause: 412, score: {…} }
```

Two reasons, both hard limits rather than style: Firestore sustains roughly **one write per
second per document**, and every write is billed. A clock writing every second is both a quota
problem and a bill. Every client already computes the same elapsed value from `startedAt` —
this is effectively what the app does now.

**Split the single JSON doc.** Today it's one blob per team (≤512 KB, under Firestore's ~1 MiB
document limit, so it *fits*) — but one doc means every listener re-downloads the whole team on
every change and the write ceiling applies team-wide. Natural shape:

```
teams/{teamId}                                  settings, roster, format
teams/{teamId}/games/{gameId}                   live game state ← the one realtime listener
teams/{teamId}/games/{gameId}/events/{evId}     append-only archive (already append-only — perfect fit)
teams/{teamId}/appearances/{gameId_player_period}   playing-time ledger
```

**`onSnapshot` + `metadata.hasPendingWrites`** gives optimistic local echo for free: the write
lands in the UI instantly, the flag tells you it hasn't reached the server yet. That replaces
`outbox.js` and its flush logic wholesale.

One regression to be honest about: Firestore is **last-write-wins per document**. The current
409/`baseRev` conflict dialog ("use the other device's version or overwrite") disappears. Splitting
the doc well makes collisions rare, but "no silent data loss" stops being a guarantee and becomes
a probability.

---

## 3. What maps, and what doesn't

| Today | Firebase | Notes |
|---|---|---|
| Worker + `public/` static assets | Firebase Hosting | Clean swap |
| D1 (one doc per team) | Firestore | See §2 for the reshape |
| `/api/*` in `src/worker.js` | Mostly **deleted** — client SDK + Security Rules | The real win: most of that file is CRUD |
| Passphrase gate, PBKDF2, signed cookie | Firebase Auth (Google sign-in / anonymous) | Deletes ~all of the auth code |
| Team token = credential | Auth uid + rules | Fixes the app's biggest security weakness |
| VAPID web push, `push_subs` | FCM | Same standard underneath |
| **GameClock Durable Object alarm** | ⚠️ **Cloud Tasks** with `scheduleTime` | Scheduled Functions are cron = 1-minute floor, the exact reason the DO exists. Cloud Tasks does second-level, but it's a function + a queue instead of one object |
| GC ICS proxy (`GC_ICS_URL` secret) | Cloud Function + Secret Manager | Needs Blaze |
| `public/_headers` CSP | `firebase.json` → `headers` | CSP must open up to `gstatic.com` + `*.googleapis.com` + `wss://*.firebaseio.com`. **The "no external origins" property is lost** |
| No build step (plain `<script>` + globals) | Realistically **add Vite** | Modular SDK is npm ESM. The gstatic CDN ESM builds work via `<script type="module">`, but the whole `new Function(src)` test idiom would need rework |
| D1 Time Travel (30-day PITR, free) | Firestore PITR is Blaze-only | Backups get *worse* on the free plan |
| `LOGIN_LIMIT` rate-limit binding | App Check | No direct equivalent on Spark |

---

## 4. Cost

Everything this app does fits Spark (free) by three orders of magnitude — one coach, two devices,
one game a week, against daily quotas in the tens of thousands of reads/writes. Two caveats:

- **Cloud Functions requires the Blaze plan** (card on file) even to stay inside the free
  allowance. That's the one line item that forces billing on. Hosting, Firestore, Auth and FCM
  all run on Spark.
- Firestore bills operations, so a design mistake (a chatty listener, a ticking clock) shows up
  as money in a way D1 never did. That's a useful thing to have felt once — arguably the most
  transferable lesson in the whole exercise.

---

## 5. Should you?

Honest read: **Cloudflare Workers + D1 + Durable Objects is the more distinctive portfolio piece.**
Firebase CRUD is the common denominator; edge Workers with a SQLite-backed Durable Object driving
exact-second push alarms is not. The portfolio argument for migrating is weaker than it looks.

The *learning* argument is fine, and there's a cheap way to buy it:

**Rebuild only the game day page against Firestore in a branch**, pointed at a throwaway Firebase
project, leaving D1 alone. One collection, one `onSnapshot`, one rules file, `persistentLocalCache`
on. You learn listeners, rules and the offline cache in an afternoon, and you can delete it.
Migrating the season archive and the appearances ledger teaches nothing the first page didn't.

---

## Sources

- [Choose a database: Firestore or Realtime Database](https://firebase.google.com/docs/database/rtdb-vs-firestore)
- [Firestore for Realtime Database developers](https://firebase.google.com/docs/firestore/firestore-for-rtdb)
- [Access data offline (Firestore)](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- [RTDB offline capabilities](https://firebase.google.com/docs/database/web/offline-capabilities)
- [Build presence in Firestore](https://firebase.google.com/docs/firestore/solutions/presence)
- [Firebase pricing plans (Spark vs Blaze)](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
- [Firestore usage and limits](https://firebase.google.com/docs/firestore/quotas)
