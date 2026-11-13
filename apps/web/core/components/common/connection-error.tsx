/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CloudOff } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";

type TConnectionErrorView = {
  /** Re-runs the failed fetch in place. Must never be a page reload — see below. */
  onRetry: () => void;
};

/**
 * Shown when one of the two bootstrap requests never reached the server (APLANE-36).
 *
 * Both screens used to misreport that failure. The workspace shell sent the user to the login page
 * as if their session had ended (authentication-wrapper.tsx), and InstanceWrapper rendered
 * MaintenanceView, whose copy reads "Looks like Plane didn't start up correctly … check your
 * container logs" with a mailto to Plane's support — advice for an administrator, about a server
 * that in the common case is perfectly healthy and simply out of reach.
 *
 * `onRetry` re-runs the fetch rather than reloading the page, deliberately: nothing in this app
 * registers a service worker (the gate asserts it as L3-11-no-service-worker-registration, and
 * `apps/web/public/sw.js` is an upstream leftover that is served but never registered), so
 * `location.reload()` on a dead connection replaces the app with the browser's own error page and
 * the user cannot get back until the network does.
 *
 * There is NO busy state on the button: both call sites sit below a spinner branch that wins while
 * the refetch is in flight (`isUserSWRLoading && !currentUser?.id`, `isInstanceSWRLoading &&
 * !instance`), so a `loading` prop here would be dead code pretending to work.
 *
 * The copy is built from keys that already exist, on purpose. Measured 2026-11-06: all 18
 * non-English locales are at 100 % parity with `en` (3837 keys each), so a new
 * "could not reach the server" key would be the fork's first parity gap — and machine-inventing 18
 * translations is worse than a correct, already-translated "please try again".
 */
export function ConnectionErrorView(props: TConnectionErrorView) {
  const { onRetry } = props;
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="relative flex h-dvh w-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <CloudOff className="size-10 text-tertiary" aria-hidden="true" />
      <p className="text-16 font-medium text-primary">{t("something_went_wrong_please_try_again")}</p>
      <Button variant="primary" size="sm" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
