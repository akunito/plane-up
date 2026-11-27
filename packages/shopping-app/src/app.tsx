// The app's root: phases (loading, signed out, no inventory...), hash routes, the toast with "Undo".
// Hash routes because the server answers unknown paths (outside /shopping/assets/) with the main app's shell (brief: Why a
// standalone app). The marker the gate looks for is in index.html, not here.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { heldEntries } from "@plane/inventory";
import type { Controller } from "./controller";
import type { Locale } from "./i18n";
import { makeT } from "./i18n";
import { AppCtx, useCtx } from "./ui";
import { Capture } from "./screens/Capture";
import { Inventory } from "./screens/Inventory";
import { ItemSheet } from "./screens/ItemSheet";
import { Pending } from "./screens/Pending";
import { Shop } from "./screens/Shop";
import { ToBuy } from "./screens/ToBuy";
import { WorkspacePicker } from "./screens/common";
import { isDevHost } from "./dev";

export type Route =
  | { name: "list" }
  | { name: "shop" }
  | { name: "capture" }
  | { name: "inventory"; list?: string }
  | { name: "item"; id: string }
  | { name: "pending" };

const ID = /^[0-9a-f-]{36}$/i;

export function parseRoute(hash: string): Route {
  const [first, second] = hash.replace(/^#\/?/, "").split("/");
  switch (first) {
    case "shop":
      return { name: "shop" };
    case "capture":
      return { name: "capture" };
    case "pending":
      return { name: "pending" };
    case "inventory":
      return second && ID.test(second) ? { name: "inventory", list: second } : { name: "inventory" };
    case "item":
      return second && ID.test(second) ? { name: "item", id: second } : { name: "list" };
    default:
      return { name: "list" };
  }
}

function useRoute(): Route {
  const [hash, setHash] = useState(() => globalThis.location?.hash ?? "");
  useEffect(() => {
    const on = () => setHash(globalThis.location.hash);
    globalThis.addEventListener("hashchange", on);
    return () => globalThis.removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}

export function App({
  controller,
  locale,
  now = Date.now,
}: {
  controller: Controller;
  locale: Locale;
  now?: () => number;
}) {
  const ctx = useMemo(() => ({ c: controller, t: makeT(locale), locale, now }), [controller, locale, now]);
  return (
    <AppCtx.Provider value={ctx}>
      <Root />
      {isDevHost(globalThis.location?.hostname ?? "") ? (
        <div className="dev-badge" data-testid="dev-badge" aria-label="Development environment">
          DEV
        </div>
      ) : null}
    </AppCtx.Provider>
  );
}

function Root() {
  const { c, t, now } = useCtx();
  const s = useSyncExternalStore(c.subscribe, c.get);
  const route = useRoute();
  // Changes held by the two-hour rule are listed as soon as the app opens (brief): once per page load, and
  // only from the to-buy list (an unparsable hash counts as the list), never over another screen opened by link.
  const askedHeld = useRef(false);
  useEffect(() => {
    if (askedHeld.current || s.phase !== "ready") return;
    askedHeld.current = true;
    if (route.name === "list" && heldEntries(s.queue, now()).length > 0) globalThis.location.hash = "#/pending";
  }, [s.phase, s.queue, route.name, now]);

  if (s.phase !== "ready") {
    const message =
      s.phase === "loading"
        ? t("loading")
        : s.phase === "signed_out"
          ? t("signed_out_title")
          : s.phase === "no_access"
            ? t("no_access")
            : s.phase === "no_inventory"
              ? t("no_inventory")
              : s.phase === "no_workspace"
                ? t("no_workspace")
                : s.phase === "newer"
                  ? t("newer")
                  : s.phase === "corrupt"
                    ? t("corrupt")
                    : t("error");
    return (
      <div className="screen center-screen" data-phase={s.phase}>
        <p className="message" role={s.phase === "loading" ? "status" : "alert"}>
          {message}
        </p>
        {s.phase === "signed_out" ? (
          // A full navigation to the main app: a fetch cannot sign in through the proxy (M4).
          <a href="/" className="primary">
            {t("sign_in")}
          </a>
        ) : null}
        {s.phase === "error" ? (
          <button type="button" className="primary" onClick={() => void c.start()}>
            {t("try_again")}
          </button>
        ) : null}
        {s.phase === "corrupt" ? (
          <button type="button" className="primary" onClick={() => void c.discardStoredQueue()}>
            {t("discard_stored")}
          </button>
        ) : null}
        {s.phase === "newer" ? (
          <button type="button" className="primary" onClick={() => globalThis.location.reload()}>
            {t("reload")}
          </button>
        ) : null}
        {s.phase === "no_inventory" || s.phase === "no_workspace" || s.phase === "no_access" ? (
          <a href="/" className="secondary">
            {t("open_main_app")}
          </a>
        ) : null}
        <WorkspacePicker />
      </div>
    );
  }

  let screen;
  switch (route.name) {
    case "shop":
      screen = <Shop s={s} />;
      break;
    case "capture":
      screen = <Capture s={s} />;
      break;
    case "inventory":
      screen = route.list ? <Inventory s={s} listId={route.list} /> : <Inventory s={s} />;
      break;
    case "item":
      screen = <ItemSheet key={route.id} s={s} id={route.id} />;
      break;
    case "pending":
      screen = <Pending s={s} />;
      break;
    default:
      screen = <ToBuy s={s} />;
  }
  return (
    <>
      {screen}
      <ToastView />
    </>
  );
}

function ToastView() {
  const { c, t } = useCtx();
  const s = useSyncExternalStore(c.subscribe, c.get);
  const toast = s.toast;
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite" key={toast.id}>
      <span className="grow">{toast.text}</span>
      {toast.undoId ? (
        <button
          type="button"
          className="link"
          onClick={async () => {
            const ok = await c.undo(toast.undoId!);
            c.showToast(t(ok ? "toast_undone" : "toast_cannot_undo"));
          }}
        >
          {t("undo")}
        </button>
      ) : null}
    </div>
  );
}
