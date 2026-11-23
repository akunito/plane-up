// Mutation check for the app's rules: each entry breaks one rule in the source, runs the suite, and
// expects at least one test to fail; the source is restored after each. Not part of the gate (a few
// minutes); run it after changing a rule: `pnpm mutations`. Every entry is a rule a review found or the
// plan names; add one when a rule is added.
/* oxlint-disable no-await-in-loop -- one mutation at a time, on purpose */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const M = [
  [
    "a workspace switch reuses the other workspace's queue",
    "src/controller.ts",
    "if (!this.store || this.storeKey !== key) {",
    "if (!this.store) {",
  ],
  ["retry timer after the backoff has passed", "src/controller.ts", "ahead <= 0 || ", ""],
  [
    "a left-out item stays on the list at a newer revision",
    "src/model.ts",
    "row.state.rev > Math.max(k.data.rev, k.offRev ?? -1)",
    "row.state.rev > k.data.rev",
  ],
  [
    "old answered orders overlaid after a reload",
    "src/model.ts",
    "if (covered) for (const e of queue.recent) if (!covered.has(e.op.client_op_id)) local.push(e);",
    "for (const e of queue.recent) if (!covered?.has(e.op.client_op_id)) local.push(e);",
  ],
  [
    "answered orders a snapshot covers still overlaid",
    "src/model.ts",
    "if (covered) for (const e of queue.recent) if (!covered.has(e.op.client_op_id)) local.push(e);",
    "if (covered) for (const e of queue.recent) local.push(e);",
  ],
  [
    "the server's verdict ignored",
    "src/model.ts",
    "if (row.quantity <= 0 || (!trustLocal && !k.onList)) continue;",
    "if (row.quantity <= 0) continue;",
  ],
  [
    "a tick buys one instead of what the list asks",
    "src/screens/ToBuy.tsx",
    'return row.state.mode === "units" ? { quantity: row.quantity } : {};',
    "return {};",
  ],
  ["a raw key on screen", "src/screens/ToBuy.tsx", '{t("badge_pinned")}', '{t("badge_pined" as Key)}'],
  ["queued order actions not overlaid", "src/model.ts", "for (const e of queue.entries) local.push(e);", ""],
  [
    "a snapshot never takes an item off",
    "src/model.ts",
    "if (listed.has(id) || k.fetchedAt >= startedAt) continue;",
    "continue;",
  ],
  [
    "order actions offer undo",
    "src/controller.ts",
    "this.showToast(options.toast, order ? undefined : (id ?? undefined));",
    "this.showToast(options.toast);",
  ],
  ["a slow older search replaces a newer one", "src/screens/Capture.tsx", "if (mine !== seq.current) return;", ""],
  [
    "a workspace without lists looks ready",
    "src/controller.ts",
    'if (lists.body.lists.length === 0) return this.set({ phase: "no_inventory", lists: lists.body });',
    "",
  ],
  ["admins who can join are not mentioned", "src/model.ts", "if (project.admins_outside > 0)", "if (false)"],
  // APLANE-73: Plane's menu.
  ["back does not close Plane's menu", "src/screens/Nav.tsx", 'globalThis.addEventListener("popstate", onPop);', ""],
  [
    "a guest of a project sees its inventory entry",
    "src/screens/Nav.tsx",
    "!!p.inventory_view && (p.member_role ?? 0) >= 15",
    "!!p.inventory_view",
  ],
  [
    "an in-app entry in the menu pushes a history entry instead of replacing the menu's",
    "src/screens/Nav.tsx",
    "globalThis.location.replace(hash);",
    "globalThis.location.hash = hash;",
  ],
  [
    "shopping mode ignores the stepper",
    "src/screens/Shop.tsx",
    'row.state.mode === "units" ? { quantity: qty } : tickArgs(row)',
    "tickArgs(row)",
  ],
  [
    "tapping the shown level sends it again",
    "src/ui.tsx",
    "onClick={() => level !== l && onLevel(l)}",
    "onClick={() => onLevel(l)}",
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
