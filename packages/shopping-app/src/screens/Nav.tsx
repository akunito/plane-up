// Plane's sidebar from inside the shopping app (APLANE-73): the main app's mobile toggle (PanelLeft) opens a
// left drawer laid out like Plane's sidebar. Opened by the button ONLY: on Android the left edge swipe is the
// system back gesture, so no edge swipe is listened for. Back closes the drawer: opening pushes one history
// entry, popstate closes. A link never leaves that entry behind (a dead back press): an in-app link replaces
// it, a Plane link replaces it with the main app's page, so back from Plane lands on the screen, drawer shut.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import type { PlaneProject } from "../controller";
import type { Key } from "../i18n";
import { board } from "../model";
import { Icon, useCtx } from "../ui";

const STATE_KEY = "planeNav";

/** The full load into the main app; tests swap it (jsdom does not navigate). */
export const leave = { to: (href: string) => globalThis.location.replace(href) };

/** The entries of ProjectNavigation, with its flags and roles (guest 5, member 15, admin 20). */
const PROJECT_NAV: readonly {
  key: Key;
  path: string;
  show: (p: PlaneProject) => boolean;
}[] = [
  { key: "nav_work_items", path: "issues", show: () => true },
  { key: "nav_cycles", path: "cycles", show: (p) => !!p.cycle_view && (p.member_role ?? 0) >= 15 },
  { key: "nav_modules", path: "modules", show: (p) => !!p.module_view && (p.member_role ?? 0) >= 15 },
  { key: "nav_views", path: "views", show: (p) => !!p.issue_views_view },
  { key: "nav_pages", path: "pages", show: (p) => !!p.page_view },
  { key: "nav_intake", path: "intake", show: (p) => !!p.inbox_view },
  { key: "nav_inventory", path: "inventory", show: (p) => !!p.inventory_view && (p.member_role ?? 0) >= 15 },
];

const sortKey = (p: PlaneProject) => (typeof p.sort_order === "number" ? p.sort_order : Infinity);

/** As the main app's joinedProjectIds: joined, not archived, by sort_order (lodash sortBy: missing last). */
export function joinedProjects(all: readonly PlaneProject[]): PlaneProject[] {
  const joined = all.filter((p) => !!p.member_role && !p.archived_at);
  return joined.toSorted((a, b) => sortKey(a) - sortKey(b));
}

function emoji(value: string | undefined): string | null {
  if (!value) return null;
  const points = value.split("-").map(Number);
  if (!points.every((n) => Number.isInteger(n) && n > 0 && n <= 0x10ffff)) return null;
  return String.fromCodePoint(...points);
}

function ProjectLogo({ p }: { p: PlaneProject }) {
  const e = p.logo_props?.in_use === "emoji" ? emoji(p.logo_props.emoji?.value) : null;
  if (e) return <span className="nav-logo emoji">{e}</span>;
  const color = p.logo_props?.in_use === "icon" ? p.logo_props.icon?.color : undefined;
  return (
    <span className="nav-logo" style={color ? { color } : undefined}>
      {(p.identifier || p.name).slice(0, 1).toUpperCase()}
    </span>
  );
}

const plainClick = (e: ReactMouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function NavToggle() {
  const { t } = useCtx();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="icon-button nav-toggle"
        aria-label={t("nav_open")}
        aria-expanded={open}
        aria-controls="plane-nav"
        onClick={() => setOpen(true)}
      >
        {Icon.panelLeft()}
      </button>
      {open ? (
        <NavDrawer
          onClosed={() => {
            setOpen(false);
            toggle.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function NavDrawer({ onClosed }: { onClosed: () => void }) {
  const { c, t } = useCtx();
  const s = useSyncExternalStore(c.subscribe, c.get);
  const ref = useRef<HTMLDivElement>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const leaving = useRef(false);
  const [projects, setProjects] = useState<PlaneProject[] | null | "failed">(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    globalThis.history.pushState({ [STATE_KEY]: true }, "");
    const onPop = () => closed.current();
    // A page restored from the back-forward cache must not come back with the drawer open over it.
    const onShow = (e: PageTransitionEvent) => e.persisted && closed.current();
    globalThis.addEventListener("popstate", onPop);
    globalThis.addEventListener("pageshow", onShow);
    ref.current?.querySelector<HTMLElement>("button, a")?.focus();
    return () => {
      globalThis.removeEventListener("popstate", onPop);
      globalThis.removeEventListener("pageshow", onShow);
      // Unmounted with its entry still current (the screen changed under it: a phase, a sign-out): take the
      // entry back, or the next back press does nothing. Not while leaving for Plane: that load replaces it.
      if (!leaving.current && globalThis.history.state?.[STATE_KEY]) globalThis.history.back();
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const all = await c.planeProjects();
      if (!live) return;
      const joined = all ? joinedProjects(all) : null;
      setProjects(joined ?? "failed");
      if (joined?.length === 1) setExpanded(new Set([joined[0]!.id]));
    })();
    return () => {
      live = false;
    };
  }, [c, s.slug]);

  /** Closes through history when the entry is ours, so back is not spent on a drawer already shut. */
  const close = () => {
    if (globalThis.history.state?.[STATE_KEY]) globalThis.history.back();
    else onClosed();
  };

  /** In-app routes replace the drawer's entry (hashchange shows the screen); the same route just closes. */
  const inApp = (hash: string) => (e: ReactMouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (globalThis.location.hash === hash || (hash === "#/" && globalThis.location.hash === "")) return close();
    globalThis.location.replace(hash);
    onClosed();
  };

  /** Plane's pages are another app: a full load that takes the drawer's entry, drawer shut first. */
  const toPlane = (href: string) => (e: ReactMouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    leaving.current = true;
    flushSync(onClosed);
    leave.to(href);
  };

  const slug = encodeURIComponent(s.slug);
  const ws = s.workspaces.find((w) => w.slug === s.slug)?.name ?? s.slug;
  const count = useMemo(
    () => board(s.known, s.queue, s.orders, s.covered).count,
    [s.known, s.queue, s.orders, s.covered]
  );
  // Offline or refused: the projects this app already knows, with the two entries every one of them has.
  const shown: PlaneProject[] =
    projects === null
      ? []
      : projects === "failed"
        ? (s.lists?.projects ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            identifier: p.identifier,
            member_role: 15,
            inventory_view: true,
          }))
        : projects;
  const top: { key: Key; href: string }[] = [
    { key: "nav_home", href: `/${slug}/` },
    { key: "nav_inbox", href: `/${slug}/notifications/` },
    ...(s.lists ? [{ key: "nav_your_work" as Key, href: `/${slug}/profile/${s.lists.me.id}` }] : []),
    { key: "nav_projects", href: `/${slug}/projects/` },
  ];

  return (
    // The scrim only adds a pointer way out; the keyboard has Escape on the drawer itself.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="nav-scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        id="plane-nav"
        className="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t("nav_label")}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="nav-head">
          <span className="nav-title">{ws}</span>
          <button type="button" className="icon-button" aria-label={t("nav_close")} onClick={close}>
            {Icon.panelLeft()}
          </button>
        </div>
        <nav className="nav-body" aria-label={t("nav_label")}>
          <a href="#/" className="nav-item" aria-current="page" onClick={inApp("#/")}>
            {Icon.cart()}
            <span className="grow">{t("nav_shopping")}</span>
            {count > 0 ? <span className="nav-count">{count}</span> : null}
          </a>
          {top.map((i) => (
            <a key={i.key} href={i.href} className="nav-item" onClick={toPlane(i.href)}>
              <span className="grow">{t(i.key)}</span>
            </a>
          ))}
          <h2 className="nav-section">{t("nav_projects")}</h2>
          {projects === "failed" ? (
            <p className="nav-note" role="status">
              {t("nav_offline")}
            </p>
          ) : null}
          {shown.map((p) => {
            const open = expanded.has(p.id);
            return (
              <div key={p.id} className="nav-project">
                <button
                  type="button"
                  className="nav-item"
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded((was) => {
                      const next = new Set(was);
                      if (open) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                >
                  <ProjectLogo p={p} />
                  <span className="nav-name grow">{p.name}</span>
                  <span className={`nav-chevron${open ? " open" : ""}`}>{Icon.chevron()}</span>
                </button>
                {open ? (
                  <div className="nav-sub">
                    {PROJECT_NAV.filter((n) => n.show(p)).map((n) => {
                      const href = `/${slug}/projects/${encodeURIComponent(p.id)}/${n.path}`;
                      return (
                        <a key={n.key} href={href} className="nav-item" onClick={toPlane(href)}>
                          <span className="grow">{t(n.key)}</span>
                        </a>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
