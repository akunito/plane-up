/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { observer } from "mobx-react";
import { useSearchParams, usePathname } from "next/navigation";
import useSWR from "swr";
// components
import { ConnectionErrorView } from "@/components/common/connection-error";
import { LogoSpinner } from "@/components/common/logo-spinner";
// helpers
import { isValidNextPath } from "@plane/utils";
import { EPageTypes } from "@/helpers/authentication.helper";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUser, useUserProfile, useUserSettings } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
// services
import { asRequestFailure } from "@/services/api.service";

type TPageType = EPageTypes;

type TAuthenticationWrapper = {
  children: ReactNode;
  pageType?: TPageType;
};

// Delegates to the shared isValidNextPath (@plane/utils) instead of a local
// reimplementation. A from-scratch version here previously resolved the
// value against location.origin and required the result to stay
// same-origin — which has its own gap: a next_path like "http:evil.com"
// resolves AS IF relative whenever the input's scheme happens to match the
// real origin's own scheme, e.g. any self-hosted deployment actually
// serving over plain http (verified directly: this bypasses the
// location.origin-based check on an http:// origin, though not on https://,
// since the schemes then differ). isValidNextPath closes this by requiring
// a literal leading "/" (and rejecting "//") before any URL-based
// comparison, so it doesn't depend on which scheme the real origin happens
// to use.
const isValidURL = isValidNextPath;

export const AuthenticationWrapper = observer(function AuthenticationWrapper(props: TAuthenticationWrapper) {
  const pathname = usePathname();
  const router = useAppRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next_path");
  // props
  const { children, pageType = EPageTypes.AUTHENTICATED } = props;
  // hooks
  const { isLoading: isUserLoading, data: currentUser, fetchCurrentUser } = useUser();
  const { data: currentUserProfile } = useUserProfile();
  const { data: currentUserSettings } = useUserSettings();
  const { loader: workspacesLoader, workspaces } = useWorkspace();

  const {
    isLoading: isUserSWRLoading,
    error: userFetchError,
    mutate: refetchCurrentUser,
  } = useSWR("USER_INFORMATION", async () => await fetchCurrentUser(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const isUserOnboard =
    currentUserProfile?.is_onboarded ||
    (currentUserProfile?.onboarding_step?.profile_complete &&
      currentUserProfile?.onboarding_step?.workspace_create &&
      currentUserProfile?.onboarding_step?.workspace_invite &&
      currentUserProfile?.onboarding_step?.workspace_join) ||
    false;

  const getWorkspaceRedirectionUrl = (): string => {
    let redirectionRoute = "/create-workspace";

    // validating the nextPath from the router query
    if (nextPath && isValidURL(nextPath.toString())) {
      redirectionRoute = nextPath.toString();
      return redirectionRoute;
    }

    // validate the last and fallback workspace_slug
    const currentWorkspaceSlug =
      currentUserSettings?.workspace?.last_workspace_slug || currentUserSettings?.workspace?.fallback_workspace_slug;

    // validate the current workspace_slug is available in the user's workspace list
    const isCurrentWorkspaceValid = Object.values(workspaces || {}).findIndex(
      (workspace) => workspace.slug === currentWorkspaceSlug
    );

    if (isCurrentWorkspaceValid >= 0) redirectionRoute = `/${currentWorkspaceSlug}`;

    return redirectionRoute;
  };

  if ((isUserSWRLoading || isUserLoading || workspacesLoader) && !currentUser?.id)
    return (
      <div className="relative flex h-screen w-full items-center justify-center">
        <LogoSpinner />
      </div>
    );

  if (pageType === EPageTypes.PUBLIC) return <>{children}</>;

  // A bootstrap request that never reached the server is NOT a signed-out session (APLANE-36).
  //
  // Every branch below answers "no user" by pushing to the login page, which is right for an
  // expired session and wrong for a radio blip: the user is sent to a sign-in screen, and on an
  // instance where the only method is an external IdP that is one more hop that cannot work
  // either. Worse, it is silent — it looks exactly like being logged out.
  //
  // A 401 never gets here, which is what makes this safe: user.service passes
  // `validateStatus: null`, so an unauthorized response RESOLVES with a body that has no `id`
  // (verified through axios 1.18.1 — mergeConfig keeps the null, and settle.js resolves when the
  // validator is falsy), `fetchCurrentUser` sets isAuthenticated false and never throws, and the
  // push below runs exactly as before. A signed-out user cannot be stranded here.
  //
  // What does reach this line: `currentUser()` rejecting with no response, and the three awaited
  // follow-ups inside `fetchCurrentUser` (profile, settings, workspaces) failing the same way.
  // NOTE this is any failure with no usable body, not only a transport one — a bodyless 502 from
  // the proxy carries `status: 502` and matches too. That is wanted here, unlike in
  // instance-wrapper, which has to tell "server unreachable" from "server broken": by the time
  // those three run, `currentUser()` has already returned an id, so the session is valid and
  // bouncing the user to a login screen would be the wrong answer whatever broke.
  //
  // Keyed on the error only to CHOOSE between two no-user outcomes, never to decide whether data
  // exists (APLANE-35): `currentUser?.id` still gates that, so a later failed revalidation over a
  // loaded user cannot reach this line. Retry is not the only way out — `revalidateOnReconnect`
  // keeps SWR's default of true (WEB_SWR_CONFIG does not set it), so the screen also clears by
  // itself when the browser fires `online`. Retry is for the case where it does not.
  const userRequestFailure = asRequestFailure(userFetchError);
  const pageNeedsUser = [EPageTypes.AUTHENTICATED, EPageTypes.ONBOARDING, EPageTypes.SET_PASSWORD].includes(pageType);
  if (pageNeedsUser && !currentUser?.id && userRequestFailure)
    return <ConnectionErrorView onRetry={() => void refetchCurrentUser()} />;

  if (pageType === EPageTypes.NON_AUTHENTICATED) {
    if (!currentUser?.id) return <>{children}</>;
    else {
      if (currentUserProfile?.id && isUserOnboard) {
        const currentRedirectRoute = getWorkspaceRedirectionUrl();
        router.push(currentRedirectRoute);
        return <></>;
      } else {
        router.push("/onboarding");
        return <></>;
      }
    }
  }

  if (pageType === EPageTypes.ONBOARDING) {
    if (!currentUser?.id) {
      router.push(`/${pathname ? `?next_path=${pathname}` : ``}`);
      return <></>;
    } else {
      if (currentUser && currentUserProfile?.id && isUserOnboard) {
        const currentRedirectRoute = getWorkspaceRedirectionUrl();
        router.replace(currentRedirectRoute);
        return <></>;
      } else return <>{children}</>;
    }
  }

  if (pageType === EPageTypes.SET_PASSWORD) {
    if (!currentUser?.id) {
      router.push(`/${pathname ? `?next_path=${pathname}` : ``}`);
      return <></>;
    } else {
      if (currentUser && !currentUser?.is_password_autoset && currentUserProfile?.id && isUserOnboard) {
        const currentRedirectRoute = getWorkspaceRedirectionUrl();
        router.push(currentRedirectRoute);
        return <></>;
      } else return <>{children}</>;
    }
  }

  if (pageType === EPageTypes.AUTHENTICATED) {
    if (currentUser?.id) {
      if (currentUserProfile && currentUserProfile?.id && isUserOnboard) return <>{children}</>;
      else {
        router.push(`/onboarding`);
        return <></>;
      }
    } else {
      router.push(`/${pathname ? `?next_path=${pathname}` : ``}`);
      return <></>;
    }
  }

  return <>{children}</>;
});
