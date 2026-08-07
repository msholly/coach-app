# Azure as a future home — research

> 2026-08-05. Exploratory, same framing as [firebase-research.md](firebase-research.md):
> the app doesn't need this, it's a learning/portfolio exercise.

**Verdict: Durable Functions (durable entities) is the one genuinely worth doing, and unlike
the Firebase migration it isn't a lateral move.**

Azure has the closest thing anywhere to what this app already is — a durable entity is the
conceptual twin of the GameClock Durable Object. It also has the one capability Firebase
lacked outright: an exact-deadline timer instead of a cron floor.

---

## 1. Durable Functions — the direct twin of GameClock

| Durable Object (today) | Durable entity (Azure) |
|---|---|
| `idFromName(teamId)` → one instance per team | Entity ID → one instance per team |
| Single-threaded; one request at a time | **Runs operations serially, one at a time per instance** |
| SQLite-backed state | Durable state (Azure Storage / Netherite backend) |
| `state.storage.setAlarm(deadline)` | `createTimer(<Date>)` |

`createTimer` takes an **arbitrary deadline**, not a cron expression — the framework enqueues a
message that becomes visible only at that instant. That matters: cerebrum's note that Cloudflare
cron's 1-minute granularity was "far too coarse for a whistle" applies to Firebase scheduled
functions too. Azure is the only one of the three with a real answer.

Porting the DO is close to 1:1, and it teaches the orchestrator / entity / activity model, which
is the actually-interesting part of Azure serverless. Entity functions are supported in JavaScript
(not PowerShell or Java).

---

## 2. Real-time game day page — Azure Web PubSub

Managed WebSocket fan-out. The browser connects with a plain `WebSocket` using the JSON
subprotocol — **no client library**, which matters a great deal for an app with no build step and
a CSP that allows no external origins ([public/_headers](../public/_headers)). A Function issues
the negotiate token.

Free tier: 1 unit, **20 concurrent connections, 20,000 messages/day**. This app has a coach and
two assistants.

The important distinction from Firestore: **Web PubSub is a message bus, not a synced database.**
It does not try to replace [outbox.js](../public/outbox.js) or the localStorage-first design — it
replaces the *polling*. Given that layer already exists and works, that fits this codebase better
than Firestore's cache did.

**The honest gap:** nothing in Azure offers Firestore's client-side offline cache. Cosmos DB has
no web-SDK offline mode. Offline stays your problem on Azure — which is fine, because it's already
solved here.

---

## 3. The rest of the stack

| Piece | Azure | Note |
|---|---|---|
| Worker + static assets | **Static Web Apps, Free tier** | 100 GB/mo bandwidth, free SSL + custom domain, 10 free-tier apps per subscription (hard cap) |
| Passphrase gate | **EasyAuth** (built into SWA) | Real replacement for the PBKDF2 + signed-cookie code |
| D1 | **Azure SQL Database free offer** | 100k vCore-seconds + 32 GB/mo per DB, up to 10 DBs, lifetime of the subscription. **The closer port** — the schema is already SQL and `json_extract` → `JSON_VALUE` |
| — or — | Cosmos DB free tier | 1000 RU/s + 25 GB, lifetime, one account per subscription. ⚠️ There's a live Microsoft Q&A thread reporting this dropped to **100 RU/s** — verify at signup |
| GameClock DO | **Durable Functions** | §1 |
| Sync polling | **Web PubSub** | §2 |
| VAPID web push | Notification Hubs, or **keep yours** | The payload-less VAPID setup is already minimal; no reason to move it |
| GC ICS proxy | HTTP-triggered Function + Key Vault | Straight port of the `redact()` pattern |

### Two gotchas to know before starting

1. **Static Web Apps *managed* functions are HTTP-trigger only — no Durable Functions.** Getting
   the game clock means "bring your own functions" (a linked backend), and **that requires the
   SWA Standard plan (~$9/mo)**.
2. **Sidestep:** deploy the Function App separately on the Consumption plan (free grant, ~1M
   executions/mo) and call it cross-origin. Costs a CORS config and a second hostname; keeps SWA
   on Free. Also worth knowing: linked backends aren't supported on SWA pull-request environments.

---

## 4. What it costs you

Sprawl. Workers + D1 + Durable Objects is three things declared in one `wrangler.jsonc`. The Azure
equivalent is Static Web Apps **+** Function App **+** a Storage Account (Durable Functions
requires one) **+** Web PubSub **+** a database **+** resource groups and RBAC around all of it.

That sprawl *is* a large part of the learning — Azure's resource model, identity, bicep/IaC — but
it's real work, and none of it makes the app better for the coach.

---

## 5. Verdict, and the cheap first step

**Durable Functions is the highest-value item across both this and the Firebase research.** Not
because the app needs it — the DO already does the job — but because "I built a second-accurate
game clock as a durable entity" is a specific, senior-sounding story, and Durable Functions turns
up in enterprise Azure shops far more often than anything Cloudflare does.

**First step:** port *only* the GameClock DO to a durable entity in a standalone Function App.
Leave everything else on Cloudflare and point `POST /api/team/:id/alarm` at it. One resource group,
one afternoon — and the pass/fail is unambiguous: the alarm either fires on the second or it doesn't.

If that goes well, Web PubSub is the natural second step, because it slots in beside the existing
sync layer rather than replacing it.

---

## Sources

- [Durable entities](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-entities)
- [Durable timers](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-timers)
- [Azure Web PubSub pricing](https://azure.microsoft.com/en-us/pricing/details/web-pubsub/)
- [API support in Static Web Apps](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions)
- [Bring your own functions](https://learn.microsoft.com/en-us/azure/static-web-apps/functions-bring-your-own)
- [Static Web Apps quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)
- [Cosmos DB lifetime free tier](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier)
- [Azure SQL Database free offer](https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer?view=azuresql)
