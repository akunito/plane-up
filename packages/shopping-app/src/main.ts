// PHASE 0 SPIKE (APLANE-58). Shows, on the device, the answers to the plan's measurements M2-M5, M9, M10.
// The only place in the repository that registers a service worker: the main bundle must never import this.
import "./style.css";

declare const __BUILD_ID__: string;

const BASE = import.meta.env.BASE_URL;
const app = document.getElementById("app")!;
const facts = new Map<string, string>();

function render(): void {
  let html = "<h1>Shopping (stub)</h1><dl>";
  for (const [k, v] of facts)
    html += `<dt>${k}</dt><dd data-fact="${k}">${v.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</dd>`;
  app.querySelector("dl")?.remove();
  app.querySelector("h1")?.remove();
  app.insertAdjacentHTML("afterbegin", html + "</dl>");
}
function fact(k: string, v: string): void {
  facts.set(k, v);
  render();
}
function button(label: string, id: string, fn: () => Promise<void>): void {
  const b = document.createElement("button");
  b.textContent = label;
  b.id = id;
  b.onclick = () => void fn().catch((e) => fact(id, "threw: " + String(e)));
  app.appendChild(b);
}

function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("shopping-stub", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const out = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const iso = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";

async function describeResponse(p: Promise<Response>): Promise<string> {
  const t0 = performance.now();
  try {
    const r = await p;
    const ct = r.headers.get("content-type") ?? "-";
    let json = "n/a";
    if (ct.includes("json")) json = "id" in ((await r.json()) as object) ? "has id" : "no id";
    return `status=${r.status} type=${r.type} redirected=${r.redirected} ct=${ct} json=${json} ${Math.round(performance.now() - t0)}ms`;
  } catch (e) {
    return `rejected: ${String(e)} ${Math.round(performance.now() - t0)}ms`;
  }
}

async function main(): Promise<void> {
  fact("build", __BUILD_ID__);
  fact("origin", location.origin + BASE);
  fact("display", matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser tab");
  fact("online", String(navigator.onLine));
  addEventListener("online", () => fact("online", "true (event)"));
  addEventListener("offline", () => fact("online", "false (event)"));

  // M9: does storage survive, and is it persistent?
  const now = Date.now();
  const first = (await kv<number>("readonly", (s) => s.get("firstSeen"))) ?? now;
  const opens = ((await kv<number>("readonly", (s) => s.get("opens"))) ?? 0) + 1;
  const prevOpen = await kv<number>("readonly", (s) => s.get("lastOpen"));
  await kv("readwrite", (s) => {
    s.put(first, "firstSeen");
    s.put(opens, "opens");
    s.put(now, "lastOpen");
  });
  fact("first seen", iso(first));
  fact("opens", `${opens} (previous: ${prevOpen ? iso(prevOpen) : "never"})`);
  fact("persisted", navigator.storage?.persisted ? String(await navigator.storage.persisted()) : "no StorageManager");

  // M10: what the worker recorded while this window may have been closed.
  const log =
    (await kv<{ at: number; status: number; online: boolean; clients: number }[]>("readonly", (s) =>
      s.get("syncLog")
    )) ?? [];
  const pending = await kv<number>("readonly", (s) => s.get("syncAsked"));
  fact("sync asked", pending ? iso(pending) : "never");
  fact(
    "sync log",
    log.length
      ? log
          .slice(-5)
          .map((e) => `${iso(e.at)} status=${e.status} online=${e.online} windows=${e.clients}`)
          .join(" | ")
      : "empty"
  );

  // M3: the worker.
  if (!("serviceWorker" in navigator)) fact("worker", "unsupported");
  else {
    try {
      const reg = await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
      await navigator.serviceWorker.ready;
      fact(
        "worker",
        `active, scope=${new URL(reg.scope).pathname}, controls this page=${navigator.serviceWorker.controller !== null}`
      );
      navigator.serviceWorker.addEventListener("message", (e) => fact("worker build", JSON.stringify(e.data)));
      reg.active?.postMessage("version");
      fact("background sync", "sync" in reg ? "API present" : "API missing");
    } catch (e) {
      fact("worker", "registration failed: " + String(e));
    }
  }

  button("Ask for persistent storage", "persist", async () => {
    fact("persist", String(await navigator.storage.persist()));
    const est = await navigator.storage.estimate();
    fact("quota", `${Math.round((est.usage ?? 0) / 1024)} KiB of ${Math.round((est.quota ?? 0) / 1048576)} MiB`);
  });
  // M4: what a read and a write look like to this origin, with and without following redirects.
  const hdr = { "X-Requested-With": "XMLHttpRequest" };
  button("API read (manual redirect, XHR header)", "read-manual", async () =>
    fact(
      "read-manual",
      await describeResponse(fetch("/api/users/me/", { redirect: "manual", headers: hdr, cache: "no-store" }))
    )
  );
  button("API read (follow, no header)", "read-follow", async () =>
    fact("read-follow", await describeResponse(fetch("/api/users/me/", { cache: "no-store" })))
  );
  button("API write (PATCH {} to users/me)", "write", async () =>
    fact(
      "write",
      await describeResponse(
        fetch("/api/users/me/", {
          method: "PATCH",
          redirect: "manual",
          headers: { ...hdr, "Content-Type": "application/json" },
          body: "{}",
        })
      )
    )
  );
  // M10: ask for a one-off sync; go offline first, close the app, restore the network, wait, reopen.
  button("Queue a background sync", "sync", async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!("sync" in reg)) return fact("sync", "API missing");
    await kv("readwrite", (s) => void s.put(Date.now(), "syncAsked"));
    await (reg as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register(
      "stub-flush-" + Date.now()
    );
    fact("sync", "registered at " + iso(Date.now()));
  });
  button("Reload", "reload", async () => location.reload());
}

void main().catch((e) => fact("fatal", String(e)));
