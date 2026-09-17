/**
 * L1-13 — Views + Analytics pinned by default in the Workspace nav (B-02)
 * L1-21 — mobile nav drawer closes after navigating, never on desktop (B-33) + scrim (B-15)
 * L1-23 — the repurposed Gitea OAuth slot presents as Pocket ID (B-32)
 */
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------- shared mocks
const nav = vi.hoisted(() => ({ pathname: "/qa/", search: "" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "qa" }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const workspace = vi.hoisted(() => ({
  prefs: undefined as Record<string, { is_pinned: boolean; sort_order: number }> | undefined,
}));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({
    getNavigationPreferences: () => workspace.prefs,
    updateBulkSidebarPreferences: vi.fn(),
  }),
}));

const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock("@plane/hooks", async (orig) => ({
  ...(await orig<object>()),
  usePlatformOS: () => ({ isMobile: platform.isMobile }),
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
const instance = vi.hoisted(() => ({ config: { is_gitea_enabled: true } as Record<string, boolean> }));
vi.mock("@/hooks/store/use-instance", () => ({ useInstance: () => ({ config: instance.config }) }));

import { ResizableSidebar } from "@/components/sidebar/resizable-sidebar";
import { useWorkspaceNavigationPreferences } from "@/hooks/use-navigation-preferences";
import { useCoreOAuthConfig } from "@/hooks/oauth/core";

// ---------------------------------------------------------------- L1-13
describe("workspace nav defaults (L1-13)", () => {
  beforeEach(() => {
    workspace.prefs = undefined;
  });

  it("with no stored preference, Views and Analytics are pinned and Archives is not", () => {
    workspace.prefs = {};
    const { result } = renderHook(() => useWorkspaceNavigationPreferences());
    expect(result.current.getWorkspaceItemState("views").is_pinned).toBe(true);
    expect(result.current.getWorkspaceItemState("analytics").is_pinned).toBe(true);
    expect(result.current.getWorkspaceItemState("archives").is_pinned).toBe(false);
  });

  it("an explicit stored false is respected (the default never overrides the user)", () => {
    workspace.prefs = { views: { is_pinned: false, sort_order: 2 } };
    const { result } = renderHook(() => useWorkspaceNavigationPreferences());
    expect(result.current.getWorkspaceItemState("views")).toEqual({ is_pinned: false, sort_order: 2 });
    expect(result.current.getWorkspaceItemState("analytics").is_pinned).toBe(true);
  });

  it("an explicit stored true for a non-default item is respected", () => {
    workspace.prefs = { archives: { is_pinned: true, sort_order: 5 } };
    const { result } = renderHook(() => useWorkspaceNavigationPreferences());
    expect(result.current.getWorkspaceItemState("archives").is_pinned).toBe(true);
  });
});

// ---------------------------------------------------------------- L1-21
function Sidebar(props: { collapsed: boolean; toggle: () => void }) {
  return (
    <ResizableSidebar
      isCollapsed={props.collapsed}
      toggleCollapsed={props.toggle}
      togglePeek={() => {}}
      width={250}
      setWidth={() => {}}
    >
      <div>nav</div>
    </ResizableSidebar>
  );
}

describe("mobile drawer (L1-21, L1-15 scrim)", () => {
  beforeEach(() => {
    nav.pathname = "/qa/";
  });

  it("mobile, open, path changes → closes once", () => {
    platform.isMobile = true;
    const toggle = vi.fn();
    const { rerender } = render(<Sidebar collapsed={false} toggle={toggle} />);
    expect(toggle).not.toHaveBeenCalled();
    nav.pathname = "/qa/projects/p1/issues/";
    rerender(<Sidebar collapsed={false} toggle={toggle} />);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("mobile, open, same path re-render (chevron, pin, '+') → stays open", () => {
    platform.isMobile = true;
    const toggle = vi.fn();
    const { rerender } = render(<Sidebar collapsed={false} toggle={toggle} />);
    rerender(<Sidebar collapsed={false} toggle={toggle} />);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("mobile, already collapsed, path changes → nothing", () => {
    platform.isMobile = true;
    const toggle = vi.fn();
    const { rerender } = render(<Sidebar collapsed toggle={toggle} />);
    nav.pathname = "/qa/views/";
    rerender(<Sidebar collapsed toggle={toggle} />);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("desktop, open, path changes → never closes the persistent sidebar", () => {
    platform.isMobile = false;
    const toggle = vi.fn();
    const { rerender } = render(<Sidebar collapsed={false} toggle={toggle} />);
    nav.pathname = "/qa/analytics/";
    rerender(<Sidebar collapsed={false} toggle={toggle} />);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("scrim is rendered only for an open drawer on mobile", () => {
    const scrim = (c: HTMLElement) => c.querySelector('[aria-hidden="true"].fixed.inset-0');
    platform.isMobile = true;
    const open = render(<Sidebar collapsed={false} toggle={() => {}} />);
    expect(scrim(open.container)).not.toBeNull();
    open.unmount();
    const closed = render(<Sidebar collapsed toggle={() => {}} />);
    expect(scrim(closed.container)).toBeNull();
    closed.unmount();
    platform.isMobile = false;
    const desktop = render(<Sidebar collapsed={false} toggle={() => {}} />);
    expect(scrim(desktop.container)).toBeNull();
  });
});

// ---------------------------------------------------------------- L1-23
describe("Pocket ID button (L1-23)", () => {
  beforeEach(() => {
    nav.search = "";
    instance.config = { is_gitea_enabled: true };
  });

  const gitea = () => {
    const { result } = renderHook(() => useCoreOAuthConfig("Sign in"));
    return result.current.oAuthOptions.find((o) => o.id === "gitea")!;
  };

  it("reads 'Sign in with Pocket ID', not Gitea", () => {
    expect(gitea().text).toBe("Sign in with Pocket ID");
    expect(gitea().enabled).toBe(true);
  });

  it("goes to the gitea route, with and without next_path", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const plain = gitea();
    plain.onClick();
    expect(assign).toHaveBeenLastCalledWith(expect.stringMatching(/\/auth\/gitea\/$/));
    nav.search = "next_path=/qa/views/";
    const withNext = gitea();
    withNext.onClick();
    expect(assign).toHaveBeenLastCalledWith(expect.stringMatching(/\/auth\/gitea\/\?next_path=\/qa\/views\/$/));
    vi.unstubAllGlobals();
  });

  it("is disabled when the instance has Gitea (Pocket ID) off", () => {
    instance.config = { is_gitea_enabled: false };
    expect(gitea().enabled).toBe(false);
  });
});
