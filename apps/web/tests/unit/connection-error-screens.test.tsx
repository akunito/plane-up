/**
 * L1-25 — a request that never reached the server is reported as such: not as a signed-out
 * session, not as a broken deployment, not as a blank page (APLANE-36).
 *
 * APLANE-36 shipped the interceptor that makes such a failure *visible* to a consumer
 * (`isRequestFailure`). These are the three consumers. Each one used to swallow it in a different
 * way, and each way looked like something else entirely:
 *   - the workspace shell pushed the user to the login page, i.e. "you are logged out"
 *   - InstanceWrapper rendered MaintenanceView, i.e. "your server is broken, read its logs"
 *   - the archived work item returned `<></>`, i.e. nothing at all
 *
 * These are render tests, not source contracts: each assertion is the thing a person would see.
 * The negative ones matter as much as the positive ones — a genuinely expired session must still
 * redirect, and a server that answered with a broken body must still get MaintenanceView.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------- shared mocks
const nav = vi.hoisted(() => ({ pathname: "/qa/", search: "" }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "qa" }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => router,
}));

vi.mock("@plane/i18n", async (orig) => ({
  ...(await orig<object>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

/** One mocked SWR per key, so a test can say exactly what each bootstrap fetch did. */
type TSwrState = { isLoading?: boolean; error?: unknown; data?: unknown; mutate?: () => void };
const swr = vi.hoisted(() => ({ byKey: {} as Record<string, TSwrState> }));
vi.mock("swr", () => ({
  default: (key: string) => ({
    isLoading: false,
    error: undefined,
    data: undefined,
    mutate: () => {},
    ...swr.byKey[key],
  }),
}));

vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => router }));

const user = vi.hoisted(() => ({
  data: undefined as { id: string } | undefined,
  profile: undefined as { id: string; is_onboarded: boolean } | undefined,
  isLoading: false,
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ isLoading: user.isLoading, data: user.data, fetchCurrentUser: vi.fn() }),
  useUserProfile: () => ({ data: user.profile }),
  useUserSettings: () => ({ data: {} }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ loader: false, workspaces: {} }) }));

const instanceStore = vi.hoisted(() => ({
  isLoading: false,
  instance: undefined as { is_setup_done: boolean } | undefined,
  error: undefined as { status: string } | undefined,
}));
vi.mock("@/hooks/store/use-instance", () => ({
  useInstance: () => ({ ...instanceStore, config: {}, fetchInstanceInfo: vi.fn() }),
}));
vi.mock("@/components/instance", () => ({
  InstanceNotReady: () => <div data-testid="instance-not-ready" />,
  MaintenanceView: () => <div data-testid="maintenance-view" />,
}));

const archived = vi.hoisted(() => ({ issue: undefined as { id: string; project_id: string } | undefined }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    fetchIssue: vi.fn(),
    issue: { getIssueById: () => archived.issue },
  }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: () => ({ identifier: "QA" }) }),
}));
vi.mock("@/components/issues/issue-detail", () => ({ IssueDetailRoot: () => <div data-testid="issue-detail" /> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));

import ArchivedWorkItemPage from "@/app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/archives/issues/(detail)/[archivedIssueId]/page";
import {
  EAuthenticationErrorCodes,
  EErrorAlertType,
  EPageTypes,
  authBannerFor,
  authErrorHandler,
} from "@/helpers/authentication.helper";
import InstanceWrapper from "@/lib/wrappers/instance-wrapper";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
import { asRequestFailure, ensureErrorPayload } from "@/services/api.service";

// ---------------------------------------------------------------- fixtures
/** What axios rejects with when nothing reached the server. */
const networkError = () => ({ message: "Network Error", code: "ERR_NETWORK", config: { url: "/api/users/me/" } });
/** What a stopped backend behind the proxy produces: an answer, with no body. */
const bodylessGateway = () => ({ message: "Request failed", code: "ERR_BAD_RESPONSE", response: { status: 502 } });

/**
 * The three throw conventions, applied to a rejection that has already been through the
 * interceptor. A consumer sees one of these three, never the axios error itself, and which one
 * depends on the service it called — which is the reason asRequestFailure exists.
 */
const asThrownBy = {
  /** `throw error?.response?.data` — auth.service.emailCheck and 375 others. */
  responseData: (error: unknown) => (ensureErrorPayload(error) as any)?.response?.data,
  /** `throw error?.response` — user.service.currentUser and 78 others. */
  response: (error: unknown) => (ensureErrorPayload(error) as any)?.response,
  /** `throw error` — instance.service.getInstanceInfo. */
  whole: (error: unknown) => ensureErrorPayload(error),
};

const RETRY = "common.retry";
const CONNECTION_MESSAGE = "something_went_wrong_please_try_again";

beforeEach(() => {
  swr.byKey = {};
  router.push.mockReset();
  router.replace.mockReset();
  user.data = undefined;
  user.profile = undefined;
  user.isLoading = false;
  instanceStore.isLoading = false;
  instanceStore.instance = { is_setup_done: true };
  instanceStore.error = undefined;
  archived.issue = undefined;
});

// ---------------------------------------------------------------- asRequestFailure
describe("asRequestFailure finds the payload under all three throw conventions (L1-25)", () => {
  it.each([
    ["throw error?.response?.data", asThrownBy.responseData],
    ["throw error?.response", asThrownBy.response],
    ["throw error", asThrownBy.whole],
  ])("%s", (_label, convention) => {
    const failure = asRequestFailure(convention(networkError()));

    expect(failure).toBeTruthy();
    expect(failure?.status).toBe(0);
    expect(failure?.axiosCode).toBe("ERR_NETWORK");
    // (not asserting `isRequestFailure` here: asRequestFailure only ever returns a candidate whose
    // flag is true, so that assertion cannot fail and would be decoration.)
  });

  it("keeps the real status when the server did answer, so callers can tell 0 from 502", () => {
    expect(asRequestFailure(asThrownBy.whole(bodylessGateway()))?.status).toBe(502);
  });

  it("returns undefined for a real API error body, a cancellation and junk", () => {
    const realBody = { error: "You do not have permission", status: 403 };

    expect(asRequestFailure(realBody)).toBeUndefined();
    expect(asRequestFailure(undefined)).toBeUndefined();
    expect(asRequestFailure("boom")).toBeUndefined();
    expect(asRequestFailure({ response: { data: { detail: "Not found" } } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the workspace shell
describe("the workspace shell does not call a dropped connection a logout (L1-25)", () => {
  const renderShell = (pageType = EPageTypes.AUTHENTICATED) =>
    render(
      <AuthenticationWrapper pageType={pageType}>
        <div data-testid="app" />
      </AuthenticationWrapper>
    );

  it("request failure, no user → retry view, and NOT a redirect", () => {
    swr.byKey.USER_INFORMATION = { error: asThrownBy.response(networkError()) };

    renderShell();

    expect(screen.getByText(CONNECTION_MESSAGE)).toBeTruthy();
    expect(screen.getByText(RETRY)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the Retry button re-runs the fetch instead of reloading the page", () => {
    const mutate = vi.fn();
    swr.byKey.USER_INFORMATION = { error: asThrownBy.response(networkError()), mutate };

    renderShell();
    screen.getByText(RETRY).click();

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("no user and no failure → still redirects to login, exactly as before", () => {
    // The regression guard. An expired session, a signed-out visitor and a 401 (which resolves,
    // because user.service passes validateStatus: null) all land here and MUST keep redirecting.
    renderShell();

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CONNECTION_MESSAGE)).toBeNull();
  });

  it("a loaded user wins over the error, so a failed revalidation cannot eject anyone", () => {
    user.data = { id: "u1" };
    user.profile = { id: "p1", is_onboarded: true };
    swr.byKey.USER_INFORMATION = { error: asThrownBy.response(networkError()) };

    renderShell();

    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByText(CONNECTION_MESSAGE)).toBeNull();
  });

  it("covers onboarding and set-password too, which redirect on the same condition", () => {
    for (const pageType of [EPageTypes.ONBOARDING, EPageTypes.SET_PASSWORD]) {
      swr.byKey.USER_INFORMATION = { error: asThrownBy.response(networkError()) };
      const { unmount } = renderShell(pageType);

      expect(screen.getByText(CONNECTION_MESSAGE)).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("but never on a page that is meant to be seen without a session", () => {
    // The login page must keep rendering: it is where the user has to end up when the session
    // really is gone, and InstanceWrapper above already owns the "cannot reach the server" screen.
    swr.byKey.USER_INFORMATION = { error: asThrownBy.response(networkError()) };

    renderShell(EPageTypes.NON_AUTHENTICATED);

    expect(screen.getByTestId("app")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- the instance gate
describe("InstanceWrapper tells an unreachable server from a broken one (L1-25)", () => {
  const renderGate = () =>
    render(
      <InstanceWrapper>
        <div data-testid="app" />
      </InstanceWrapper>
    );

  it("nothing reached the server → retry view, not the container-logs page", () => {
    swr.byKey.INSTANCE_INFORMATION = { error: asThrownBy.whole(networkError()) };

    renderGate();

    expect(screen.getByText(CONNECTION_MESSAGE)).toBeTruthy();
    expect(screen.queryByTestId("maintenance-view")).toBeNull();
  });

  it("a bodyless 502 → MaintenanceView, because the server DID answer and is the problem", () => {
    // The precise reason the branch tests `status === 0` rather than the flag: the interceptor
    // also fills in a payload when the response had an empty body, and that is what a stopped
    // backend behind Caddy produces.
    swr.byKey.INSTANCE_INFORMATION = { error: asThrownBy.whole(bodylessGateway()) };

    renderGate();

    expect(screen.getByTestId("maintenance-view")).toBeTruthy();
  });

  it("a real error body → MaintenanceView, exactly as before", () => {
    swr.byKey.INSTANCE_INFORMATION = { error: { response: { status: 500, data: { error: "boom" } } } };

    renderGate();

    expect(screen.getByTestId("maintenance-view")).toBeTruthy();
  });

  it("no error → the app, and an unconfigured instance still gets its own screen", () => {
    renderGate();
    expect(screen.getByTestId("app")).toBeTruthy();

    instanceStore.instance = { is_setup_done: false };
    render(
      <InstanceWrapper>
        <div data-testid="app2" />
      </InstanceWrapper>
    );
    expect(screen.getByTestId("instance-not-ready")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- the archived work item
describe("the archived work item never renders a blank page (L1-25)", () => {
  const SWR_KEY = "ARCHIVED_ISSUE_DETAIL_qa_p1_i1";
  // react-router's generated Route.ComponentProps also demands a 7-element `matches` tuple that
  // this page never reads. Constructing it would be noise; the cast is the whole concession, and
  // `tsc --noEmit` is part of the deploy gate, so leaving it off instead would have failed L0-02.
  type TPageProps = Parameters<typeof ArchivedWorkItemPage>[0];
  const renderPage = () =>
    render(
      <ArchivedWorkItemPage
        {...({
          params: { workspaceSlug: "qa", projectId: "p1", archivedIssueId: "i1" },
          matches: [],
        } as unknown as TPageProps)}
      />
    );

  it("settled with no work item → the empty state, where there used to be nothing at all", () => {
    swr.byKey[SWR_KEY] = { isLoading: false };

    renderPage();

    expect(screen.getByText("issue.empty_state.issue_detail.title")).toBeTruthy();
    expect(screen.getByText("issue.empty_state.issue_detail.primary_button.text")).toBeTruthy();
  });

  it("its button goes where its label says: the same destination as the sibling route", () => {
    swr.byKey[SWR_KEY] = { isLoading: false };

    renderPage();
    screen.getByText("issue.empty_state.issue_detail.primary_button.text").click();

    expect(router.push).toHaveBeenCalledWith("/qa/workspace-views/all-issues/");
  });

  it("still loading → the skeleton, which the old `if (!issue) return <></>` made unreachable", () => {
    swr.byKey[SWR_KEY] = { isLoading: true };

    renderPage();

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("issue.empty_state.issue_detail.title")).toBeNull();
  });

  it("loaded → the work item, with its archived banner", () => {
    archived.issue = { id: "i1", project_id: "p1" };
    swr.byKey[SWR_KEY] = { isLoading: false };

    renderPage();

    expect(screen.getByTestId("issue-detail")).toBeTruthy();
    expect(screen.queryByText("issue.empty_state.issue_detail.title")).toBeNull();
  });
});

/**
 * The three throw conventions above are not a guess: they are read out of the services this
 * ticket's branches depend on. If one of them changes shape, asRequestFailure has to learn the new
 * one, and the render tests would keep passing against a fixture that no longer matches reality —
 * which is exactly how the `is_app=False` slip got through in APLANE-37.
 */
describe("the services still throw what asRequestFailure is built for (L1-25)", () => {
  const read = (relative: string) => {
    const candidates = [join(process.cwd(), relative), join(process.cwd(), "apps", "web", relative)];
    const path = candidates.find(existsSync);
    if (!path) throw new Error(`not found: ${relative}`);
    return readFileSync(path, "utf8");
  };

  // Method-scoped on purpose: each of these files holds several throw sites, and matching the bare
  // line anywhere in the file would pass even if the method this ticket depends on changed.
  it.each([
    ["core/services/auth.service.ts", "emailCheck", /emailCheck = async[\s\S]{0,400}?throw error\?\.response\?\.data;/],
    ["core/services/user.service.ts", "currentUser", /async currentUser\(\)[\s\S]{0,400}?throw error\?\.response;/],
    ["core/services/instance.service.ts", "getInstanceInfo", /async getInstanceInfo\(\)[\s\S]{0,400}?throw error;/],
  ])("%s (%s)", (file, _method, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  it("and user.service still resolves unauthorized responses instead of rejecting them", () => {
    // The reason the shell's redirect-on-401 keeps working untouched: with `validateStatus: null`
    // axios resolves every status, so a 401 arrives as a body with no `id` and never as a throw.
    expect(read("core/services/user.service.ts")).toMatch(/validateStatus: null/);
  });
});

/**
 * The sign-in form. This is the half of the diff the render tests above cannot reach, and the half
 * where the audit found the only blocking defect — so the first test here is the one that would
 * have caught it.
 */
describe("the sign-in form reports a request failure instead of nothing (L1-25)", () => {
  it("the client-side code cannot collide with the server's auth error codes", () => {
    // 5999 was the first value chosen, and apps/api already uses it for "AUTHENTICATION_FAILED",
    // its generic Unknown. Since auth-root.tsx feeds `?error_code=` straight into
    // authErrorHandler, that would have printed "Could not reach the server" for a real
    // authentication failure. This reads the server's own table, so the day a code is added there
    // the clash is a test failure rather than a wrong message on the login page.
    const api = [
      join(process.cwd(), "..", "..", "apps", "api", "plane", "authentication", "adapter", "error.py"),
      join(process.cwd(), "apps", "api", "plane", "authentication", "adapter", "error.py"),
    ].find(existsSync);
    if (!api) throw new Error("apps/api error.py not found");
    const serverCodes = new Set([...readFileSync(api, "utf8").matchAll(/^\s*"[A-Z_]+":\s*(\d+),/gm)].map((m) => m[1]));

    expect(serverCodes.size).toBeGreaterThan(40);
    expect(serverCodes.has("5999")).toBe(true);
    expect(serverCodes.has(EAuthenticationErrorCodes.REQUEST_FAILED)).toBe(false);
    expect(Number.isNaN(Number(EAuthenticationErrorCodes.REQUEST_FAILED))).toBe(true);
  });

  it("a request failure becomes a banner, where an unknown code produced none", () => {
    const banner = authBannerFor(asThrownBy.responseData(networkError()));

    expect(banner?.type).toBe(EErrorAlertType.BANNER_ALERT);
    expect(banner?.code).toBe(EAuthenticationErrorCodes.REQUEST_FAILED);
    expect(banner?.title).toBeTruthy();
  });

  it("and WITHOUT the fix the same failure produces nothing at all", () => {
    // The control: the old line, reproduced. `error_code` is undefined on a synthetic payload, and
    // authErrorHandler returns undefined for an unknown code, which the call site then skips.
    const payload: any = asThrownBy.responseData(networkError());

    expect(payload.error_code).toBeUndefined();
    expect(authErrorHandler(payload?.error_code?.toString())).toBeUndefined();
  });

  it("a real server error code still wins, and still carries the email through", () => {
    const banner = authBannerFor({ error_code: EAuthenticationErrorCodes.INVALID_EMAIL }, "a@b.c");

    expect(banner?.code).toBe(EAuthenticationErrorCodes.INVALID_EMAIL);
    expect(banner?.type).toBe(EErrorAlertType.BANNER_ALERT);
  });
});
