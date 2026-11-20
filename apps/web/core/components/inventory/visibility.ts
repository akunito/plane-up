// When the main app shows inventory at all (plan: "the sidebar entry and the widget render only when the
// viewer can see a project with inventory on"), and the to-buy count shared by the sidebar counter and the
// Home widget (S20: counter = widget count = list count).

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchShoppingList } from "@plane/inventory";
import { useProject } from "@/hooks/store/use-project";

/** Project roles that may use inventory: Member and Admin. A guest never sees it (brief). */
const MEMBER_ROLE = 15;
export const INVENTORY_CHANGED = "plane-inventory-changed";

/** A link into the shopping app that opens the workspace it was clicked in (the app reads ?ws=). A plain
 * anchor: /shopping/ is another app and must load in full, never through the router (S51). */
export const shoppingHref = (slug: string, hash = ""): string => `/shopping/?ws=${encodeURIComponent(slug)}${hash}`;

/** Tells the sidebar counter and the widget that something changed from this tab. */
export function notifyInventoryChanged(): void {
  window.dispatchEvent(new Event(INVENTORY_CHANGED));
}

/** True when a project the viewer joined, as a member or admin, has inventory on. Read from the lite
 * project list in the store, so it costs no request and follows the flag when a project is updated. */
export function useInventoryVisible(): boolean {
  const { joinedProjectIds, getPartialProjectById } = useProject();
  for (const id of joinedProjectIds) {
    const p = getPartialProjectById(id);
    if (p?.inventory_view && typeof p.member_role === "number" && p.member_role >= MEMBER_ROLE) return true;
  }
  return false;
}

/** The viewer's to-buy count, refreshed on focus, on becoming visible and after a change from this tab.
 * `null` until known or when it cannot be read: the counter is then simply not shown. */
export function useShoppingCount(slug: string, enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const out = await fetchShoppingList({ base: "", slug });
    // An older answer landing last must not bring back an older count (phase 5 audit).
    if (mine === seq.current) setCount(out.kind === "ok" ? out.list.count : null);
  }, [slug]);
  useEffect(() => {
    if (!enabled || !slug) {
      setCount(null);
      return;
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onChange = () => void load();
    window.addEventListener("focus", onChange);
    window.addEventListener(INVENTORY_CHANGED, onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener(INVENTORY_CHANGED, onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, slug, load]);
  return count;
}
