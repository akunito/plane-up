// Mutation check for the queue's rules: each entry breaks one rule in the source, runs the suite, and
// expects at least one test to fail; the source is restored after each. Not part of the gate (about two
// minutes); run it after changing a rule: `pnpm mutations`. Every entry is a rule a review found or
// the plan names; add one when a rule is added.
/* oxlint-disable no-await-in-loop -- one mutation at a time, on purpose */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const M = [
  [
    "undo removes a transmitted entry",
    "src/queue.ts",
    'if (queued && queued.transmission === "never") {',
    'if (queued && queued.transmission !== "answered") {',
  ],
  ["no two-hour hold", "src/queue.ts", "return !entry.approved && ageOf(entry, now) > HOLD_AFTER_MS;", "return false;"],
  [
    "a held entry does not block what follows",
    "src/queue.ts",
    "    if (isHeld(e, now)) break;",
    "    if (isHeld(e, now)) continue;",
  ],
  [
    "unanswered entries dropped",
    "src/queue.ts",
    "    if (!r) {\n      entries.push(entry);\n      continue;",
    "    if (!r) {\n      continue;",
  ],
  [
    "discard keeps its undos",
    "src/queue.ts",
    '    if (e.op.op === "revert" && e.op.args.reverts === entry.op.client_op_id) ids.add(e.op.client_op_id);\n',
    "",
  ],
  [
    "another user's queue sent",
    "src/queue.ts",
    "if (state.userId !== currentUserId || state.sending) return null;",
    "if (state.sending) return null;",
  ],
  [
    "one replay check removed",
    "src/queue.ts",
    "if (state.userId !== currentUserId || state.sending) return null;",
    "if (state.userId !== currentUserId) return null;",
  ],
  [
    "apply anyway for any refusal",
    "src/queue.ts",
    'if (notice.kind !== "stale" || !notice.item) throw',
    "if (!notice.item) throw",
  ],
  [
    "refused tick stays under Done",
    "src/queue.ts",
    "    if (entry.tick) done = withoutDone(done, new Set([entry.op.client_op_id]));\n",
    "",
  ],
  [
    "no backoff",
    "src/queue.ts",
    "  if (f && now < f.nextTryAt && f.nextTryAt - now <= BACKOFF_MAX_MS) return null;\n",
    "",
  ],
  [
    "backoff trusts a clock that went back",
    "src/queue.ts",
    "f && now < f.nextTryAt && f.nextTryAt - now <= BACKOFF_MAX_MS",
    "f && now < f.nextTryAt",
  ],
  [
    "known may go backwards",
    "src/queue.ts",
    "  if (!current || item.rev >= current.rev) known[item.id] = item;",
    "  known[item.id] = item;",
  ],
  [
    "gone always drops the item",
    "src/queue.ts",
    '    if (r.item) keepNewer(known, r.item);\n    // "gone" with an item is a missing order or reverted event; only "gone" without one is the item.\n    else if',
    "    if (r.item) keepNewer(known, r.item);\n    if",
  ],
  [
    "60-day rule only for unsent",
    "src/queue.ts",
    "  return ageOf(entry, now) > DISCARD_ONLY_AFTER_MS;",
    '  return entry.transmission === "never" && ageOf(entry, now) > DISCARD_ONLY_AFTER_MS;',
  ],
  [
    "double undo queues two",
    "src/queue.ts",
    "if (!entry || entry.undone || NOT_REVERTIBLE.has(entry.op.op)) return state;",
    "if (!entry || NOT_REVERTIBLE.has(entry.op.op)) return state;",
  ],
  [
    "refused undo leaves Done empty",
    "src/queue.ts",
    "        done = restoreTick(done, original, state.doneSince);\n      }",
    "      }",
  ],
  [
    "already_done treated as a refused undo",
    "src/queue.ts",
    'if (entry.op.op === "revert" && r.reason !== "already_done") {',
    'if (entry.op.op === "revert") {',
  ],
  [
    "refused undo revives an original refused in the same batch",
    "src/queue.ts",
    "recent.find((e) => e.op.client_op_id === target) ?? entries.find((e) => e.op.client_op_id === target);",
    "recent.find((e) => e.op.client_op_id === target) ?? state.entries.find((e) => e.op.client_op_id === target);",
  ],
  [
    "ticks come back from before Finish",
    "src/queue.ts",
    "  if (!original?.tick || original.tappedAt < doneSince) return done;",
    "  if (!original?.tick) return done;",
  ],
  [
    "removing an undo leaves its tick out",
    "src/queue.ts",
    "    done = restoreTick(done, original, state.doneSince);\n  }\n  return { entries, recent, done };",
    "  }\n  return { entries, recent, done };",
  ],
  [
    "undo always previewed",
    "src/queue.ts",
    "      if (reverted === undefined || reverted.op.client_op_id !== entry.op.args.reverts) continue;",
    "      if (reverted === undefined) continue;",
  ],
  [
    "undo previews the screen's state, not the server's",
    "src/ops.ts",
    "      const b = before;",
    "      const b = before ?? reverted.before ?? undefined;",
  ],
  ["predicted refusals advance the last step", "src/queue.ts", "      predictRefused(item, entry) ||\n", ""],
  [
    "second arrival of an order previewed",
    "src/queue.ts",
    '(entry.op.op === "arrived" && status === "received") ||',
    "false ||",
  ],
  [
    "order removal keeps its arrivals",
    "src/queue.ts",
    '  const orderId = entry.op.op === "mark_ordered" && entry.transmission === "never" ? entry.op.args.order_id : undefined;',
    "  const orderId = undefined;",
  ],
  [
    "ids compared by case",
    "src/queue.ts",
    "    const r = byId.get(entry.op.client_op_id.toLowerCase());",
    "    const r = results.find((x) => x.client_op_id === entry.op.client_op_id);",
  ],
  [
    "duplicate's current rev taken as produced",
    "src/queue.ts",
    "      const rev = r.rev ?? (r.duplicate ? undefined : r.item?.rev);",
    "      const rev = r.item?.rev;",
  ],
  [
    "base_rev from the optimistic view",
    "src/queue.ts",
    "return enqueue(state, buildOp(name, known, args,",
    "return enqueue(state, buildOp(name, { ...known, rev: known.rev + state.entries.length }, args,",
  ],
  [
    "delta 0 not predicted",
    "src/ops.ts",
    '      return item.mode !== "units" || !isInt(a.delta) || a.delta === 0;',
    '      return item.mode !== "units";',
  ],
  [
    "replay loops without progress",
    "src/replay.ts",
    '          if (answeredCount(batch!, delivery.results) === 0) return onFailed(s, "server", now(), { status: 200 });\n',
    "",
  ],
  [
    "lock skips instead of waiting",
    "src/replay.ts",
    "  let tail: Promise<unknown> = Promise.resolve();\n  return (fn) => {\n    const run = tail.then(fn, fn);",
    "  let busy = false;\n  let tail: Promise<unknown> = Promise.resolve();\n  return (fn) => {\n    if (busy) return Promise.resolve(undefined);\n    busy = true;\n    const run = tail.then(fn, fn).finally(() => (busy = false));",
  ],
  [
    "stale 'sending' kept under an exclusive lock",
    "src/replay.ts",
    "    if (lock.exclusive) await store.update((s) => (s.sending ? { ...s, sending: false } : s));\n",
    "",
  ],
  [
    "refusal reported as server",
    "src/replay.ts",
    '            return onFailed(s, "refused", now(), { status: delivery.status, error: delivery.error });',
    '            return onFailed(s, "server", now());',
  ],
  ["no request timeout", "src/client.ts", "  init.signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);\n", ""],
  [
    "bad JSON throws",
    "src/client.ts",
    "  try {\n    body = await response.json();\n  } catch {",
    "  body = await response.json();\n  if (false) {",
  ],
  [
    "load keeps the backoff",
    "src/storage.ts",
    "  return { ok: true, state: onRestart(state as QueueState) };",
    "  return { ok: true, state: { ...(state as QueueState), sending: false } };",
  ],
];

let failed = 0;
for (const [name, path, from, to] of M) {
  const source = readFileSync(path, "utf8");
  if (source.split(from).length !== 2) {
    console.log(`NOT APPLIED  ${name}`);
    failed++;
    continue;
  }
  writeFileSync(path, source.replace(from, to));
  let caught = false;
  try {
    execFileSync(process.execPath, [process.env.VITEST_BIN ?? "node_modules/vitest/vitest.mjs", "run"], {
      stdio: "ignore",
    });
  } catch {
    caught = true;
  } finally {
    writeFileSync(path, source);
  }
  console.log(`${caught ? "caught      " : "NOT CAUGHT  "}${name}`);
  if (!caught) failed++;
}
console.log(`${M.length - failed}/${M.length} caught`);
process.exit(failed ? 1 : 0);
