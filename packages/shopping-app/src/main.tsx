// Entry of the standalone shopping app. The service worker is registered here only: anything the main
// bundle imports must never register one (gate L3-11).
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is a side effect by nature
import "./style.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Controller } from "./controller";
import { pickLocale } from "./i18n";
import { SYNC_TAG } from "./worker-core";

// The main app's links name the workspace they were clicked in (?ws=slug): without it the app opens the
// workspace it remembers, so a counter read in workspace B would lead to A's list (phase 5 audit). The
// parameter is dropped from the address once read, so a reload or an installed start keeps the choice.
const params = new URLSearchParams(location.search);
const asked = params.get("ws")?.trim() ?? "";
if (params.has("ws")) history.replaceState(history.state, "", `${location.pathname}${location.hash}`);
const deps: ConstructorParameters<typeof Controller>[0] = { base: "", onQueued: requestSync };
if (asked) deps.slug = asked;
const controller = new Controller(deps);
const locale = pickLocale(navigator.languages ?? [navigator.language]);
document.documentElement.lang = locale;
createRoot(document.getElementById("app")!).render(<App controller={controller} locale={locale} />);
controller.attach(window);
void controller.start();

// ---------------------------------------------------------------- the worker (phase 6)
// Registered here and nowhere else (gate L3-11). Its scope is the app's: /shopping/.

/** A one-off background sync: the browser fires it once it sees a network, while it is alive (M10). */
function requestSync(): void {
  void navigator.serviceWorker?.ready
    .then((reg) =>
      (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register(SYNC_TAG)
    )
    .catch(() => {
      // No Background Sync (Firefox, Safari) or refused: the page sends on open, online and focus.
    });
}

/** Unsaved work on screen: an open dialog, a toast (its Undo), or text typed in a field. */
function busy(): boolean {
  return (
    !!document.querySelector('[role="dialog"], .toast') ||
    [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].some(
      (el) => el.type !== "checkbox" && el.type !== "radio" && el.value !== ""
    )
  );
}

if ("serviceWorker" in navigator) {
  // A page that already had a worker is replaced by the new version's on the next hide, never in front of
  // the person; the very first install takes over a page that had none, and needs no reload.
  let hadController = !!navigator.serviceWorker.controller;
  let reloadWhenHidden = false;
  // Never over unsaved work (phase 6 audit): switching apps to copy a name would lose the text typed in
  // the search or a dialog, and a toast's Undo. The old page keeps working meanwhile (one chunk, no lazy
  // imports, so nothing it needs is gone); the reload waits for a hide with nothing pending.
  const reloadIfIdle = () => {
    if (document.visibilityState === "hidden" && !busy()) location.reload();
    else reloadWhenHidden = true;
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    reloadIfIdle();
  });
  document.addEventListener("visibilitychange", () => {
    if (reloadWhenHidden && document.visibilityState === "hidden") reloadIfIdle();
  });
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === "queue-changed") void controller.reloadQueue();
  });
  void navigator.serviceWorker.register("/shopping/sw.js", { scope: "/shopping/" }).catch(() => {
    // No worker (private window, an old browser): the app works online, and offline until the page closes.
  });
  // Ask the browser not to evict the queue under storage pressure (granted silently to installed apps).
  void navigator.storage?.persist?.().catch(() => undefined);
}
