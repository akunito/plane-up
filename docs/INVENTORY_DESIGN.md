# Inventory and shopping lists — design brief

Status: v5, 2026-11-19 — v4 plus the corrections of review round 4 and the owner's decisions of that day. No code exists. Implementation plan: `docs/INVENTORY_PLAN.md`.

How far to trust this: the product decisions are the owner's. Everything else is the designer's. Three review rounds the same day **each found the rules for concurrent and offline changes unsound**, the last two in the corrections of the round before. v4 did not patch those rules again: it replaced them with a much smaller set and pushed the cases a server cannot decide to the person holding the phone. Round 4 judged that sound with corrections — the two server behaviours held; what it corrected were definitions on the device, things to write down as accepted, and where the gate learns what to expect. **Those round-4 corrections are in this text and have not themselves been reviewed.** Code facts carry a `file:line` and were re-read by the author on branch `akunito/mobile-v1.4.1`.

## What it is

A household stock and shopping feature inside the fork: recurring items that must not run out (baby supplies, household, groceries, supplements), a shopping list derived from them, and a shopping mode for the store. The goal is zero friction: marking that something is running out must take about two seconds on a phone.

## Product decisions (owner, 2026-11-19) — requirements

1. **Project-scoped, several lists per project.** Inventory is a project feature like Cycles or Pages. A list belongs to a project and is visible to that project's members. No separate sharing model.
2. **Four modes per item**, chosen per item, with a default mode per list: `pinned` (always on the shopping list as a reminder on every trip, no stock tracked — for fast-moving groceries), `on_demand` (on the list only while flagged "needed"), `level` (ok / low / out; on the list while low or out), `units` (quantity with a minimum; on the list while below it). A pin button toggles `pinned` ⇄ `on_demand` in one tap.
3. **Consumption is manual, one tap.** No consumption-rate estimation.
4. **The shopping list is a derived view** across every list the user can see. Default grouping is category/aisle; switchable to list, store or urgency.
5. **Shopping is a session.** "Finish shopping" clears what was ticked: pinned items come back unticked with a "bought N days ago" hint.
6. **"Ordered" state for online purchases**, so two people do not order the same thing; "Arrived" restocks.
7. **No notifications outside the app.** Only the counter and the Home widget.
8. **Optional item fields**: store, purchase URL, brand/variant, last price (stored, never prompted; its purpose is ordering through MCP), expiry date (single, optional, rarely used), photo and barcode (plain optional fields, no scanner).
9. **Entry points**: an own home-screen icon that opens the shopping list directly, the first entry of the sidebar with a counter, and a Home widget placed first.
10. **Integration in v1: Claude through MCP only.**
11. **Day-one scope**: two-second capture on the phone, shopping mode, working without coverage, full management on desktop.
12. **Devices**: two Android phones on Chromium browsers plus desktop Brave. No iOS.
13. **Seed data**: a proposed starter catalog per list merged with the users' current notes list. Existing one-off "X to buy" work items stay work items.
14. **Process**: built on dev until complete; a test harness; every workflow and combination exercised in desktop Brave and on a physical Android phone over adb before prod.

## Designer defaults

Confirmed by the owner on 2026-11-19: ticks applying at once, "Done" per device, no access for guests, the standalone app, what works without coverage, the two-hour rule, and the behaviours listed below. Also agreed that day: the app is installed from both hostnames if that proves possible, otherwise from the public one; the empty tables ship to prod ahead of the feature provided the service keeps working; the mockups are approved (plan, "Decisions"). The rest are details nobody has objected to.

- **A tick applies at once**, not at "Finish shopping" (see "Why ticks apply at once").
- **"Done" lives on the device.** It lists what was ticked on this device since the last "Finish shopping", which empties it; it also empties itself after six hours without a tick. The server stores no shopping session. Decision 5 holds: after finishing, pinned items are back unticked with their hint.
- **The counter is the number of rows on the viewer's to-buy list, minus pinned ones.** It is per viewer. An item fully covered by an order is not on the to-buy list.
- **Guests have no access to inventory**: 403 on every inventory endpoint. Only a project's members see that project's lists; the owner restated this as a requirement.
- **Categories and stores are free text on the item, and the aisle order is per user** (see "Why no workspace-level tables").
- **The phone screens are a standalone app at `/shopping/`** (see "Why a standalone app").
- **Other people's changes arrive by polling**: on focus, on reconnect, after one's own action and every 20 s while a shopping screen is visible.
- **Without coverage you can shop and capture, not manage.** The last list is shown and you can tick, change a level, tap + and −, type a recount, flag "needed", pin, mark ordered, mark arrived, cancel an order. Creating an item, changing its mode and editing its data need a connection.
- **What was done without coverage is sent by itself when the connection returns** — the owner's requirement. With the app open that is immediate. With the app closed it depends on the browser granting background sync, which is unmeasured; if it does not, the changes go out the next time the app is opened, and the app must say how many are waiting.
- **Changes that have waited more than two hours are not sent by themselves.** The app lists them as soon as it opens and asks: send or discard, one by one or all. Until the person answers, nothing queued behind them is sent either. A server cannot know whether Monday's purchase is still true on Thursday; the person can.
- **Items bought online** (`buy_online`) carry a "mark ordered" action instead of a tick box and are not shown in shopping mode. An item with no store set is shown in shopping mode.
- **Every one-tap action on an item shows an undo toast.** Order actions do not (see Orders).
- **Quantity to buy** for a `units` item is `max(1, restock_to − max(quantity, 0) − on order)`; an empty `restock_to` means "the minimum".
- **"Urgency" grouping** orders rows: out, then low or below minimum, then needed, then pinned.
- **Price is informational.** No spend reports in v1.
- **Photo is the last thing built** and may slip; barcode is a text field from the start.
- **UI languages**: en, es, pl, from dictionaries local to the inventory code. No new keys go into `packages/i18n`.

### Behaviours the rules produce on purpose

Consequences, not bugs. Each has a scenario in the plan so that changing one is a deliberate act.

1. **A purchase always counts when it reaches the server**, whatever anyone said about the item before it arrived. If A buys detergent in a store without coverage and B marks it "out" ten minutes later, it is "ok" once A's phone syncs. If B meant that what A bought is already gone, B says so again.
2. **A need flagged on an item that is already on order is cleared when the order arrives.**
3. **A recount does not know about changes still waiting on another phone**, purchases or uses. When they arrive they are added or subtracted. If the count had already seen them, the total is off — too high after a late purchase, too low after a late "−1" — until someone recounts. The same holds for the quantity typed when an item becomes `units`. The two-hour rule and background sync, where the browser grants it, keep that window short.
4. **A wrong phone clock** changes only the times shown and whether that phone asks before sending.
5. **"Done" is per device.** Ticks made on the phone do not appear under "Done" on the desktop.
6. **Two installs are two apps.** If the app is installed from both hostnames, a change waiting in one is invisible in the other until it has been sent, and each has its own "Done".

## Privacy: what "private list" really means

A list is exactly as private as its project, which is weaker than "a project with one member":

- New projects default to public — `Project.network` has `default=2`, `apps/api/plane/db/models/project.py:76`.
- Any workspace Member can add themselves to a public project, and any workspace Admin to a secret one — `apps/api/plane/app/views/project/invite.py:145-159`: the only refusal is a secret project for a non-admin.

So a private list needs a **secret** project and no other workspace admin. The UI says who can see each list instead of asserting "only you" from the member count, and creating the first list in a public single-member project warns.

## Item state

| Mode | Fields used | On the to-buy list when |
|---|---|---|
| `pinned` | — | always, unless on order |
| `on_demand` | `needed`, `needed_by`, `needed_at` | `needed`, unless on order |
| `level` | `level` (ok, low, out) | low or out, unless on order |
| `units` | `quantity` (state); `min_quantity`, `restock_to` (data) | `max(quantity, 0) + on order < min_quantity` |

- Every item, in any mode, keeps when it was last bought and by whom. That is the "bought N days ago" hint on pinned rows and the "bought while on order" mark below.
- A state field belongs to one mode. Changing mode clears the state fields the new mode does not use. `min_quantity` and `restock_to` are the item's data, not state: a mode change keeps them, so leaving `units` and coming back restores the same thresholds, and the database rule `restock_to ≥ min_quantity` can never fire on a mode change (phase 1 audit). Changing **to** `units` carries the quantity typed by the user: it is a recount, never a leftover. If `min_quantity` is empty, the change sets it to 1, as for a new `units` item; otherwise the item could never reach the list.
- Pinning an `on_demand` item clears `needed`. Unpinning gives `on_demand` with `needed = false`; the toast offers "needed".
- "Buy" and "arrived" are mode-independent: they carry a quantity (1 if absent) and take effect according to the item's mode **when they are applied** — `pinned` records the purchase, `on_demand` clears `needed`, `level` becomes ok, `units` adds the quantity. A purchase therefore survives a mode change made in between. Any other operation that makes no sense for the current mode is rejected as `invalid_for_mode`.
- `units`: `min_quantity ≥ 0`, and `restock_to` is empty or `≥ min_quantity`, both enforced in the database. **`quantity` is a signed integer and the server never clamps it**, because clamping at zero would make the result depend on the order in which two phones' changes arrive. A negative total is shown as 0 with a "recount" mark. A new `units` item gets a minimum of 1.
- `quantity == min_quantity` is not on the list.
- The last-bought time only moves forward, except when the purchase that set it is reverted.
- Items are created online. A new item goes onto the to-buy list at once: `on_demand` → needed, `level` → low, `units` → quantity 0 with minimum 1, `pinned` → nothing to do. Within a list, live items have distinct names (compared without case or extra spaces); creating a second one offers the existing item.

## Moving an item

An import or any other writer that has no external id writes NULL, never an empty string: the database's uniqueness of `(project, external_source, external_id)` treats two empty strings as the same key.


An item moved to another list keeps everything. Moved to another project, it takes its orders and history with it: the engine rewrites `project` and `workspace` on its orders and events in the same transaction, because both are copies with a cascade, and deleting the old project would otherwise take them (phase 1 audit). A bulk `update()` does not run the model's `save()`, which is what keeps `workspace` in step, so the move sets both explicitly.

## Orders

- `InventoryOrder`: item, quantity, status, received quantity, who and when, source (web or api), free-text reference, optional expected date, and when and by whom the item was bought while the order was open. Several open orders per item are allowed.
- Operations name the **order**. Its id is made on the device when it is marked ordered, so an arrival or a cancel tapped later without coverage can still name it. When an item has more than one open order, "Arrived" asks which.
- **Order actions cannot be reverted.** "Mark ordered" is undone by cancelling the order; an arrival or a cancel tapped by mistake is corrected by hand.
- **A purchase that lands on an item with an open order** is recorded on each open order at the moment it is applied (`bought_since_at`, `bought_since_by`). The first such purchase keeps the stamp; later ones do not overwrite it. An arrival is an order being fulfilled, not a purchase: it stamps none of the item's other open orders (S15). Reverting the purchase that set a stamp clears it again, so the event records which orders it stamped. It cannot be derived from the item's last-bought time, which is the purchase's own time and can predate the order when it was made offline (S64).
- **Such a purchase** (one person bought it in a store while the other ordered it) does not change the order's status or quantity. The row under "On the way" then says it was bought since, by whom, and offers to cancel the order. The people decide; the server does not.
- Transitions: open → received, open → cancelled, cancelled → received (the parcel came anyway). Nothing leaves received: a second "arrived" or a cancel on a received order is rejected as `already_done`.
- "Arrived" is one step: the order becomes received and the item gets a "buy" for the received quantity (the ordered quantity if none is given). It always applies.
- While an item has an open order it is off the to-buy list and shown under "On the way" with its current state. A `units` item stays on the to-buy list for the part no order covers.
- A smaller quantity than ordered closes the order with what came; the rest returns to the list by the normal rule, and a remainder that turns up later is added with +.
- Cancel closes the order; the item returns to the list if it is still needed.
- The server marks an order open for more than ten days as overdue; it is highlighted in "On the way". In-app only.
- Marking an item ordered while it has an open order warns first. Two orders placed offline cannot be prevented; both stay visible.
- A request made with an API key is recorded with source `api`, which is how the history tells an MCP order from one made by hand.

### Why ticks apply at once

With effects deferred to "Finish" and ticks shared between two phones: if "Finish" applies everyone's ticks, one person finishing commits a tick the other is about to undo at the checkout. If it applies only one's own, a tick abandoned on a phone that ran out of battery hides a pinned item from the other person the next day. A "Finish" queued offline carries no list of items. And a `units` item restocked at "Finish" cannot get the right number if someone at home used one in the meantime. Applying each tick as it happens removes the shared deferred state all four depend on, and with it any need for the server to know about a session.

## Operations and concurrency

Every state change is an operation `{v, client_op_id, queue_id, target, op, args, base_rev, age_ms}` sent to one endpoint. The server has exactly two behaviours.

**Always applies** — things that happened:

- adjust a `units` quantity by ±n;
- buy (a tick);
- mark ordered (creates an order);
- arrived and cancel, which are checked only against the order's own status (see Orders), never against the item's revision.

**Applies only if nothing changed** — statements about the present:

- set level, set needed, pin or unpin, change mode, recount (type the quantity). Each carries `base_rev`, the item revision the device held **when the user tapped**. If the item's state changed since, the result is `stale` and nothing is written. Changes made by the same person from the same queue do not count as "changed", otherwise the second of two offline taps on one item would always be refused; a change by anyone else, or by the same person from elsewhere, does.
- **revert** (undo, untick) names the operation it reverts — an adjust, a buy or one of the statements above — and only the person who made that operation can revert it, from any of their devices. It applies only if that operation was applied **and the item has not changed since that operation**, whatever revision the device now holds. Reverting a ±n or a `units` purchase applies the opposite amount; reverting anything else restores the state that was there before. It never restores item data: a minimum edited since stays, and a minimum a switch to `units` filled in stays after that switch is undone. A refused revert is `rejected`, never `stale` (reasons `changed_since`, `not_yours`, `not_revertible`, `already_done`, `gone`): "apply anyway" exists only for `stale`, and could never apply a revert.

**What "the same queue" means.** `queue_id` is a random id made once per installed app and per signed-in user; two people on one phone never share it. A surface that keeps no queue — the Home widget, the project page, MCP — sends a fresh random id with every request, so nothing it sends is ever exempt from the check.

Every applied operation, including a ±1 and every order action, advances the item's revision. Editing an item's data (name, category, store, URL, variant, price, expiry, barcode, minimum, restock level, list) does not: that goes through an ordinary online update, which cannot write state fields.

Rules that hold for all operations:

- **Results**: applied, stale, or rejected with a reason (gone, forbidden, invalid for mode, already done, unsupported version, invalid — malformed, out of range, or refused by the database's own rules, answered for that operation alone (a transient database failure is a 5xx instead, so the device retries rather than drops); duplicate id — someone else's `client_op_id`; and the revert reasons above). A duplicate delivery returns the recorded result, marked as a duplicate — after the authorisation check, so someone who has lost access gets "forbidden", not an old result. `client_op_id` is a random id made on the device and is unique on its own.
- **One operation, one database transaction**, with a row lock on its item and database-side arithmetic. There is no transaction around a batch, so two phones' batches cannot deadlock each other and one bad operation cannot undo the others. A request carries at most 100 operations; a longer queue goes in several requests.
- **The queue is strictly first-in, first-out.** A failed request (no network, a 5xx, a sign-in page or a redirect instead of JSON) is retried later with the same ids, so an operation the server had in fact applied is recognised and not applied twice. Nothing is reordered, dropped or set aside automatically. If the server keeps failing, the queue stays blocked and says so; only the user can discard its first entry, and is told it may already have been applied. One replay runs at a time per device.
- **Undoing something not yet delivered.** An entry that has never been transmitted is undone by removing it. An entry that has been transmitted, answered or not, is undone by queueing a revert behind it. "Not yet answered" is not "not sent": removing such an entry would leave its effect on the server. An undo that cannot do anything (an order action or revert already sent, a refused operation, one already undone, one older than the device's last 50 applied) does nothing and the toast says nothing. A never-sent entry is removed with what cannot stand without it: the undos that name it and, for an order never sent, the arrivals and cancels queued for it. If the server refuses an undo, or the person removes an undo not yet sent, the tick goes back under "Done" and the person is told — unless "Done" was emptied since ("Finish shopping" or the six-hour reset), the original was itself refused, or the refusal says the undo already happened (`already_done`).
- **Discarding an entry** also discards what depends on it, as for undo. If it was a tick, its row leaves "Done" and the person is told; the same happens when the server refuses a tick.
- **`stale` is shown at once** with what changed and who changed it. "Apply anyway" is a new operation with a new id and the fresh revision. It exists only for `stale`.
- **The two-hour rule is the device's**: before sending, entries older than two hours are held and listed for the user. A held entry blocks everything behind it, like any other; background sync never sends past one. Sent ones keep their original ids and follow the rules above. An entry older than 60 days, sent or not, can only be discarded: the ledger keeps 90 days, and a retry after that would apply twice.
- **Authorisation is per operation.** The endpoint is workspace-level, and the project permission decorator reads `project_id` from the URL (`apps/api/plane/app/permissions/base.py:68-73`), so it cannot protect a batch. Each operation resolves its target and requires that the requester is an active Member or Admin of that item's **current** project, in the workspace of the URL, with the project neither archived nor deleted and inventory enabled.
- **Time.** The device records its clock at the tap and again at sending; `age_ms` is the difference. The server clamps it to between zero and 60 days and uses receive time minus age only to show when something happened. **No server rule depends on it.**
- **What the device knows only moves forward.** An answer or a refresh replaces the device's copy of an item only if its revision is not older; an applied answer names the revision it produced (`rev`), because a duplicate answer carries the item's current state. The preview of an undo is shown only while the server would apply it, and (except for a ±n) only from the server's state right before the step, which is what the server restores. Accepted, and shown once answered: an entry whose answer was lost and whose effect a refresh already shows is previewed twice until its retry is answered; an undo is not previewed when someone else changed the item just before the step or after a lost-then-duplicate answer; an arrival or cancel of an order the device has no record of is previewed as applied. A request that gets no answer within 30 seconds counts as offline.
- **A request that fails as a whole is retried, never dropped**: no answer, 5xx, a sign-in page or redirect (M4), an answer matching none of the batch, or a refusal of the whole request (403 when the person lost access to inventory, 400). The last is shown as such, since discarding the head does not fix it. One replay at a time per device; a second caller waits for the first instead of skipping, so nothing tapped in between is stranded. The backoff ends when the app opens or the connection returns, and a backoff longer than its maximum (the clock went back) is over.
- **Queue ownership.** The queue is stored per user and replayed only while its owner is signed in. `v` is the operation format version; the server rejects one it does not know, and the app then asks to be updated instead of discarding.
- **Ledger.** Every received operation is recorded with its result. Events are pruned after 90 days, which is why an entry older than 60 days is never sent.

What this deliberately does not try to do: decide by itself between a late purchase and a later statement (behaviour 1), reconcile a recount with goods still in someone's bag (behaviour 3), or merge two people's sessions. Earlier versions tried, with rules that contradicted one another.

## The derived list: what the query must filter on

The existing cross-project pattern is `WorkspaceModulesEndpoint` (`apps/api/plane/app/views/workspace/module.py:27-31`): membership and `is_active` in the **same** `filter()` call, plus `project__archived_at__isnull=True`. The inventory query needs more, because the soft-delete manager does not apply across joins and the soft-delete cascade is an asynchronous task:

- an `Exists` on `ProjectMember` for this user, active, role Member or Admin (the default manager already excludes soft-deleted memberships);
- project not deleted, not archived, `inventory_view` on;
- list not deleted; item not deleted;
- the workspace of the URL.

A workspace admin gets nothing extra: `allow_permission` only widens rights inside projects the admin already belongs to. The counter, the widget, the list and the suggestions all use this one visibility rule.

## Why no workspace-level tables

Workspace-level categories and stores would be readable by every workspace member, guests included, and writable by any Member (`WorkspaceEntityPermission`, `apps/api/plane/app/permissions/workspace.py:74-90`). The names used by a private list would be visible to everyone, and any member could rename or delete a category that only another person's private items use, through a soft-delete task that has no restore. Free text on the item has none of that.

- Values are stored trimmed with single spaces and compared without regard to case.
- Suggestions are the distinct values over the items the user can already see.
- Renaming is a bulk update over the items the user may edit.
- The aisle order is a per-user list of names; a category not in someone's list sorts after the ones that are. A rename by one person therefore shows up as an unordered category for the other until they place it.
- The cost is no referential integrity: the picker offers existing values first, and the MCP tools refuse an unknown category unless told to create it.

## Why a standalone app

- The deploy gate fails on any service worker in the main app: `L3-11-no-service-worker-registration` passes only when nothing under the main bundle registers one, and it also runs inside the prod smoke, where a red result rolls prod back. The rule is deliberate (`apps/web/core/components/common/connection-error.tsx:26-28`).
- Nothing registers a worker today, so the installed app cannot cold-start offline, and the main app's boot depends on API calls that fail offline before any route renders.
- The main bundle is far too heavy for a two-second capture.

So the phone screens are a small separate app, built by `apps/web` as a second Vite build into `build/client/shopping/` and served by the existing static file server at `/shopping/`.

- **Build order.** `react-router build` empties the whole build directory first (`cleanBuildDirectory`, `@react-router/dev` 7.17.0, `dist/vite.js:5400-5406`), so the second build runs after it, inside `apps/web`'s own `build` script. The image build prunes to `web`'s declared workspace dependencies (`apps/web/Dockerfile.web:21`), so both new packages are declared in `apps/web/package.json`.
- **Routing.** Hash routes, because the server's fallback returns the main app's `index.html` for unknown paths. `/shopping` without the trailing slash is outside the worker's scope, so the shell redirects to `/shopping/`.
- **Links from the main app are full page loads.** Inside the main app the client router would treat `/shopping` as a workspace (`route(":workspaceSlug")`, `apps/web/app/routes/core.ts:63`). The sidebar entry cannot be an item of the static list: `SidebarItemBase` prefixes the workspace slug, renders a client-side link and translates a key (`apps/web/core/components/workspace/sidebar/sidebar-item.tsx:66-75`). It is its own small component with a plain anchor, rendered above that list.
- **The worker's registration lives only in the shopping app's entry file**, never in the shared package: anything the main bundle imports that registers a worker turns L3-11 red.
- **Manifest and worker.** Own manifest with `id`, `scope` and `start_url` all `/shopping/`; own worker with that scope; data and the queue in IndexedDB.
- **Sign-in.** Same origin, so the session cookie is sent. There is no CSRF token to fetch: cookie-authenticated writes are checked by origin (`apps/api/plane/authentication/session.py:56-63`). When a request is answered with a sign-in page or a redirect, the app offers a full navigation to the main app, because a cached shell never navigates by itself. The client sends `X-Requested-With: XMLHttpRequest` on every request and tells three cases apart — signed out of the app, signed out of the proxy, no network (see "Measured in phase 0", M4).
- **Two hosts are two apps.** The internal and the public hostname are different origins: two installs, two queues, two "Done" lists that know nothing of each other. The owner wants both installed if that is possible and the **public** one if only one can be (2026-11-19). With the public one, "sent when the connection returns" depends on having a connection and nothing else. What is known: the internal name resolves to a VPN address, so away from home it needs the VPN up; both real phones are VPN nodes and both were offline on it when checked; the public name sits behind an authenticating proxy, whose session expires (M4, M11).
- **Reserved name.** `shopping` joins both lists of restricted workspace names (`apps/api/plane/utils/constants.py:5` and `RESTRICTED_URLS` in `packages/constants/src/workspace.ts:12`), after checking that no workspace already has it.

The surfaces inside the main app (sidebar entry, Home widget, project page) talk to the same endpoints directly and only while online; they keep no queue.

Both UIs share one package of pure TypeScript: types, the derivation rules, operation building, the queue, the API client.

## Facts about the fork (read 2026-11-19, branch `akunito/mobile-v1.4.1`)

- Project feature flags: `apps/api/plane/db/models/project.py:95-101`. A new flag does **not** reach the sidebar from the model alone: the sidebar reads the lite project list, a hard-coded `.values(...)` (`apps/api/plane/app/views/project/base.py:176-197`). It must also go into the lite project type, **both** project navigation lists (`apps/web/core/components/workspace/sidebar/project-navigation.tsx:71`, `apps/web/core/components/navigation/use-navigation-items.ts:33`), the features list (`apps/web/core/components/project/settings/features-list.tsx:25-71`), and the routes file. The external-API serializer lists fields explicitly (`apps/api/plane/api/serializers/project.py:72-94`).
- Home widgets need three registrations: `HOME_WIDGETS_LIST` (`apps/web/core/components/home/home-dashboard-widgets.tsx:27`), `HomeWidgetKeys` (`apps/api/plane/db/models/workspace.py:377`), the `THomeWidgetKeys` union (`packages/types/src/home.ts:11`). Rows are created lazily on read with `sort_order = 1000 − n` (`apps/api/plane/app/views/workspace/home.py:28-58`), so a key added later ties with an existing one; "first" needs an explicit order.
- App views accept an API key as well as a session (`apps/api/plane/app/views/base.py:78`), so MCP calls the UI's own endpoints. The per-key rate limit exists only on the external API views (`apps/api/plane/api/views/base.py:61-62`); inventory views add it themselves. Every request carrying an API key writes an activity-log row (`apps/api/plane/middleware/logger.py:383-390`).
- Manifests: two links are emitted (`apps/web/app/root.tsx:42`, `:46`); the first, `/site.webmanifest.json`, has no `id`, `scope` or `shortcuts`.
- Migrations run by themselves when the image starts (`deployments/aio/community/supervisor.conf:7-9`); a rollback only swaps the image back. The gate requires the latest applied migration to equal the latest shipped one (L3-16). Latest migration: `0127`.
- Foreign keys have no `ON DELETE` in the database: Django performs cascades itself, so **code that does not know a model cannot delete the parents of its rows**. The hard-delete task dies on a `DO_NOTHING` foreign key for the same reason (`apps/api/plane/bgtasks/deletion_task.py:586-594`), and its collection phase breaks above roughly 65 000 doomed rows of one model (`:178-183`). New models use neither `DO_NOTHING` nor `PROTECT`; the event table is a plain model without soft delete and with nothing depending on it.
- File assets attach through an entity-type enum (`apps/api/plane/db/models/asset.py:37-47`) and several per-type switches in the asset views. A photo is a multi-file change with its own storage clean-up.
- i18n: 19 locales at full parity, never edited by the fork, and by stated policy not to be extended (`connection-error.tsx:36-39`). A key missing everywhere renders as the raw key and nothing fails the build.
- Claude reaches Plane through an upstream MCP server that has no inventory tools.

## Measured in phase 0

Each line says how it was measured. "Part" means the rest of that measurement is still open in the plan.

- **M0, browsers (owner, and read from the test phone, 2026-11-19).** Both real phones use Edge Canary. The test phone has Edge Canary 152 as its default browser, and Chrome.
- **M7, column defaults (run 2026-11-19 in the API test container, Django 5.2.15, a throwaway migration on a database of its own).** A field added with `default=False` produces `ADD COLUMN … DEFAULT false NOT NULL` followed by `ALTER COLUMN … DROP DEFAULT`: the database keeps no default. Code that does not know the column then cannot create a project at all — `IntegrityError: null value in column … violates not-null constraint`. The same field with `db_default=False` keeps the default, and the older code creates projects normally. **So every column this feature adds to an existing table carries `db_default` or is nullable**; otherwise a rollback to an image from before the column breaks project creation.
- **M5, part (test phone over USB, 2026-11-19).** Edge Canary's debugging socket is `chrome_devtools_remote_<process id>`; Chrome's has no suffix. With the browser in the background the socket accepts a connection and never answers; brought to the front, it answers at once. The connection survives airplane mode, and the network is back about three seconds after airplane mode is turned off. Not yet measured: attaching to the installed app's own window.
- **M4, part (`curl` without a session, 2026-11-19; no browser yet).** On the internal host an API request without a session gets `401` with a JSON body. On the public host the proxy answers `302` to another origin with an HTML body; a page's `fetch` cannot follow or read a redirect like that (expected from the fetch specification, not yet seen on the device), so to the app it would look like a dead network. The same request with `X-Requested-With: XMLHttpRequest` gets `401` with an HTML body instead. Three cases the client can therefore tell apart: `401` with JSON — signed out of the app; `401` without JSON — signed out of the proxy; no answer — no network. The session cookie belongs to one hostname and slides: it lasts 90 days from the last request (deployment setting, read from the running containers). Two installs therefore mean two sign-ins. Not yet measured: a write from `/shopping/` against the origin check, and all of this inside the installed app.

Measured with the stub deployed to dev (spike branch, image built and gated by the normal dev deploy, 2026-11-19):

- **M1, serving.** The two-step build works in the image build; the dev gate is green with it, including L3-11 (the shopping worker sits under `/shopping/`, which that check does not scan). `/shopping/`, its script, stylesheet, worker (`text/javascript`), `.json` manifest and PNG icons answer 200 with the right types. A file named `.webmanifest` is served with **no content type**: the manifest keeps the `.json` name. `/shopping` answers `308` to `/shopping/`, so the app needs no redirect of its own. **A missing file under `/shopping/` answers `200` with the main app's HTML**, so the worker must reject any precached response whose type does not match what it asked for, and the gate's asset check must test types, never status alone. No cache headers are sent on any of these files.
- **M1, build helper.** A helper imported by `apps/web/vite.shopping.config.ts` must live inside `apps/web`: that project's typecheck rejects a file outside its include list (TS6307), and the gate's typecheck stage counts it against the baseline. The root `.gitignore` ignores every `build/` directory, so no source file may live in one.
- **M2, part.** Edge Canary reports the stub installable with no errors and installs it from its menu ("Install and create shortcut" → "Install"). It does not create a separate Android package: the icon is a pinned shortcut that launches the browser's own web-app mode, like the other web apps on that phone. Not yet seen: whether it then opens standalone, and whether it can sit next to an installed main app.
- **M3, yes.** With the browser force-stopped and airplane mode on, the installed stub cold-started from its launch intent and the worker served it (`controller` set, `onLine` false); IndexedDB kept what the previous open wrote.
- **M4, part, in the browser.** Signed out, on the internal host, a read and a write from `/shopping/` both get `401` with JSON, with or without following redirects. Signed in (2026-11-20, the owner's session on the test phone, Edge Canary): the session cookie is `session-id`, path `/`, HttpOnly, Secure, SameSite=Lax, so it is sent to `/shopping/` too; a read and a write (`PATCH {}`) from the origin both answer 200 with JSON, with or without following redirects, so the origin check lets the app's writes through. Still to do: the public host, which exists only in prod.
- **M10, measured three ways.** A one-off background sync registered offline: with the app in the background and the browser alive, it fired about three seconds after the network returned; with the browser force-stopped it did not fire in four and a half minutes of network, and fired the moment the browser started again, before any window of the app existed; in between, with the process frozen by the system, it fired when the app was reopened. **So "sent by itself when the connection returns" holds while the browser is alive. Otherwise it is sent the next time the browser starts for any reason.** The app still flushes on every open and shows how many changes are waiting.

Rehearsed on dev with a throwaway model, `M6Probe` (rows tied to a workspace and a project), plus a `projects` column with `db_default`, on spike branches, 2026-11-19:

- **M6.** (1) The branch with the model deployed green; six rows were created in the `qa` workspace. (2) `--rollback dev` to an image without the model: it starts and serves, its migrator exits cleanly, and creating a project works (the column's database default fills it — M7 confirmed on the real stack). But that image cannot delete the workspace: `IntegrityError … violates foreign key constraint … on table "m6_probes"`, and the gate says so out loud — L3-16 red (`applied=0128… shipped=0127…`) and the QA seed `FATAL`. **The rollback command itself runs neither check**, so after a rollback past a migration the failure shows only at the next deploy or smoke. (3) An unrelated deploy on top of the model, rows present: fully green; the seed's reset removed the rows by cascade. So "schema ships first" is enough, and anything else is caught, not silent.
- **M6, consequence for prod.** Once inventory rows exist in prod, a rollback of prod to an image from before phase 1 leaves L3-16 red and every purge of a workspace or project holding inventory rows failing. That rollback is not available from then on; the way back is forward.
- **M8.** The shared packages' tests run on the workstation with the vitest already in the local package store (linked into the package, 4 tests in 124 ms). Only `apps/web`'s jsdom tests stay runner-only.
- **M12.** On the server, `git cat-file -e <image tag>:packages/shopping-app/package.json` in the runner's checkout gives the right answer for both running images and for the image `.previous-image` names (dev with the stub: expected; prod: not expected). A tag whose commit the checkout does not have gives no answer, and the gate must treat that as red, never as "not expected".

## The deploy gate and this feature

The gate is one committed script set that runs for **every** ref, on one shared runner, against one shared dev database. Five things follow.

1. **Checks must know whether to expect the feature, and must not find out from the thing they check.** A check that runs "if the app is in the image" passes when a broken build left the app out. Expectation is a property of the **image under test**: its tag is the commit it was built from, and that commit's tree either contains the shopping package or does not. Every stage derives it from the tag of the image actually running, which also gives the right answer for the image a rollback restores. It is not kept in a file: the deployed-ref marker is written only after the checks that would need it, and a rollback deletes it. When the feature is expected, the image checks, the inventory seed and its contract are all mandatory.
2. **The existing shell-assets check cannot be reused for `/shopping/`.** It requires a title starting with "Plane" and at least three assets: it would pass on a missing app (the server answers with the main shell) and fail on a small real one. The new check keys on a marker only the shopping shell has, and runs where the existing one runs: right after each image swap on dev and prod, and in the prod smoke.
3. **QA data.** The QA seed runs on every deploy and its contract asserts the exact projects and members of the `qa` workspace; the visual baselines live only on the runner and are shared by every ref. Inventory test data therefore goes into a QA workspace of its own, with inventory left off in `qa`, so no existing contract or baseline changes. The seed's reset list gains that workspace, the seed creates it only when the image is expected to have the feature, and its manifest entry keeps the shape the seed's summary loop reads for every workspace.
4. **Every schema change ships dark to the main branch and prod before the feature branch creates rows of that shape on dev.** The seed's reset and the purge delete through Django; an image without the inventory models cannot delete a workspace that holds inventory rows, and the deploy fails at the seed. Refreshing dev from prod does not help: the refresh starts dev on whatever image it last ran, which re-applies the migration and reseeds. The only alternative is to deploy nothing else while this is built.
5. **Lists the gate hard-codes.** The unit stage enters a fixed list of directories; the API stage runs only `plane/tests/unit` and `plane/tests/contract` inside a container that mounts only `apps/api`; the end-to-end stage runs `apps/web/tests/e2e` on three projects, one of them WebKit.

Each new check gets a self-test for three cases — feature expected and app missing (red), expected and present (green), not expected (skipped) — and the changed gate is run against the current main ref before it is merged.

## Proposed model

- `Project.inventory_view`: boolean, `default=False` **and** `db_default=False` (M7).
- `InventoryList` (project): name, default mode, sort order.
- `InventoryItem` (project, list): name, mode, the state fields above, `state_rev`, category, store, `buy_online`, purchase URL, variant, last price and currency, expiry date, barcode, photo (late), sort order, external source and id (so the seed import can be re-run).
- `InventoryOrder` (project, item): as under Orders.
- `InventoryPreference` (workspace, user): category order, default grouping.
- `InventoryEvent` (plain model, no soft delete): item, project, workspace, actor, queue id, order, `client_op_id` (unique), operation, arguments, result and reason, previous values (for revert), resulting revision, source, time shown, server time. It is the history, the idempotency ledger and the revert record.

## API

Under `/api/workspaces/<slug>/inventory/`, session or API key:

- `shopping-list/` — the to-buy list, the counter, "on the way".
- `ops/` — a batch of operations.
- `suggestions/` and `preferences/`.
- Project-level create, update and delete of lists and items (data only, online only).

MCP tools, in a small server of its own: shopping_list, list_items, list_categories, upsert_item (data only), set_level, adjust_quantity, set_quantity, set_needed, set_pinned, mark_ordered, mark_received, cancel_order.

## Surfaces

| Surface | Lives in | Purpose |
|---|---|---|
| Shopping list | standalone app | what to buy, grouped; "On the way"; "Done" on this device |
| Shopping mode | standalone app | large rows, tick with quantity, finish |
| Quick capture | standalone app, widget | search, one-tap action per mode; create (online) |
| Inventory | standalone app | all items per list, pin toggle, levels, steppers, recount |
| Item sheet | standalone app, project page | mode, minimum, organisation, purchase data, barcode, history |
| Waiting and unapplied changes | standalone app | changes held by the two-hour rule; `stale` results with "apply anyway"; a blocked queue |
| Sidebar entry | main app | first entry, counter, full page load to `/shopping/` |
| Home widget | main app | to-buy list with ticks and capture, online only; links to the app |
| Project › Inventory | main app | desktop table, inline editing, lists, feature toggle, aisle order |

Not yet mocked up: the grouping switch's other options, the waiting-and-unapplied screen, typing a recount, the order dialog (quantity, reference, expected date, which order arrived), partial arrival and cancel, expiry display, list creation with its default mode, the aisle-order editor, the "recount" mark, the warning for a public single-member project.

## What the tests can and cannot show

Nothing in the existing suite runs offline, runs two sessions at once, installs a PWA, or drives a physical phone (the "android" project is Chromium emulation). API tests run with `--nomigrations` on a reused database. Nothing rehearses a rollback over a migrated schema, and no stage runs the hard-delete task over real data. The plan adds a check or a rehearsal for each.

Three limits remain whatever is added. The server and the client read the same fixture, so a rule that is wrong in this brief passes on both sides; the scenario catalogue in the plan is the independent statement, which is why its expected results are outcomes, not rule names, and why the engine also gets a randomized test over generated two-device histories. A catalogue tests one rule per row and misses interactions; that randomized test is the only thing aimed at them. And how the phones' browser kills workers and evicts storage is seen only by hand on a device. The test phone runs the same browser as the real ones (plan, M0), but it is a canary build that changes weekly.

## Review record

- Round 1, code: confirmed v1's file:line facts; found the service-worker gate rule, automatic migrations versus rollback, the flag plumbing, the privacy of single-member projects, the workspace-level leak, the purge rules, widget and sidebar mechanics, the cheaper MCP route.
- Round 1, semantics: found the session model, absolute operations on replay, undo, the order state, the `needed` flag across modes, missing invariants, ticks without a finish, the missing live channel, and the mockup inconsistencies.
- Round 2, on v2: unsound. An automatic re-send cancelled compare-and-set; clamped deltas did not commute; the gate changes would have broken every deploy of the main branch; the asset check was inverted; the sidebar entry could not open the app; no recount; incomplete orders.
- Round 3, on v3: unsound. "A recount supersedes earlier deltas" erased purchases whose goods were still in the bag; setting failed operations aside and re-sending them under new ids double-applied them, and a deploy restart would have parked whole queues; arrivals had two results; untick was defined two ways; the age clamp contradicted the expiry rule; server-side trips conflicted with "one open trip"; the QA seed could not delete inventory rows from an image without the models; visual baselines are shared across refs; conditional checks passed on a missing app.
- v4's response to round 3 was to remove what kept breaking — recount supersession, the 12-hour rule, expiry, parking, server-side trips, offline creation — and add the two-hour rule on the device.
- Round 4, on v4: sound with corrections. The two server behaviours held. Corrected since, and not re-reviewed: the gate read its expectation from a marker written after the checks that needed it (now derived from the image tag); undoing an entry that was sent but not yet answered left its effect on the server; whether held entries block the queue was unstated; queue identity was undefined for the widget, MCP and two users on one phone; a store purchase landing on an item someone had just ordered left a silent duplicate order; a late "−1" after a recount was not among the accepted behaviours; order actions cannot be undone; "refresh dev before unrelated deploys" does not work.
- Every finding acted on was re-read in the code or the documents first. Not verified by reading: Django's handling of a column default after `AddField`, how the phones' browser treats a second manifest on one origin, whether it grants background sync — all in phase 0.
