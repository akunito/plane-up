// The app's root: phases (loading, signed out, no inventory...), hash routes, the toast with "Undo".
// Hash routes because the server answers unknown paths with the main app's shell (brief: Why a
// standalone app). The marker the gate looks for is in index.html, not here.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
    </AppCtx.Provider>
  );
}

function Root() {
  const { c, t } = useCtx();
  const s = useSyncExternalStore(c.subscribe, c.get);
  const route = useRoute();

  if (s.phase !== "ready") {
    const message =
      s.phase === "loading"
        ? t("loading")
        : s.phase === "signed_out"
          ? t("signed_out_title")
          : s.phase === "no_inventory"
            ? t("no_inventory")
            : s.phase === "no_workspace"
              ? t("no_workspace")
              : s.phase === "newer"
                ? t("newer")
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
        {s.phase === "newer" ? (
          <button type="button" className="primary" onClick={() => globalThis.location.reload()}>
            {t("reload")}
          </button>
        ) : null}
        {s.phase === "no_inventory" || s.phase === "no_workspace" ? (
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
      {route.name === "list" ? <WorkspacePicker /> : null}
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

/** Shown only to someone in more than one workspace. */
function WorkspacePicker() {
  const { c, t } = useCtx();
  const s = useSyncExternalStore(c.subscribe, c.get);
  if (s.workspaces.length < 2) return null;
  return (
    <label className="select workspace">
      <span className="muted small">{t("workspace")}</span>
      <select value={s.slug} onChange={(e) => void c.switchWorkspace(e.target.value)}>
        {s.workspaces.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}
