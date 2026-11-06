/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// components
import { ConnectionErrorView } from "@/components/common/connection-error";
import { LogoSpinner } from "@/components/common/logo-spinner";
import { InstanceNotReady, MaintenanceView } from "@/components/instance";
// hooks
import { useInstance } from "@/hooks/store/use-instance";
// services
import { asRequestFailure } from "@/services/api.service";

type TInstanceWrapper = {
  children: ReactNode;
};

const InstanceWrapper = observer(function InstanceWrapper(props: TInstanceWrapper) {
  const { children } = props;
  // store
  const { isLoading, instance, error, fetchInstanceInfo } = useInstance();

  const {
    isLoading: isInstanceSWRLoading,
    error: instanceSWRError,
    mutate: refetchInstanceInfo,
  } = useSWR("INSTANCE_INFORMATION", async () => await fetchInstanceInfo(), { revalidateOnFocus: false });

  // loading state
  if ((isLoading || isInstanceSWRLoading) && !instance)
    return (
      <div className="relative flex h-screen w-full items-center justify-center">
        <LogoSpinner />
      </div>
    );

  // `&& !instance`: without it a failed revalidation replaces a loaded, working app with an error
  // screen — the APLANE-35 defect exactly, in the branch below. `revalidateOnReconnect` keeps
  // SWR's default of true, so that revalidation does happen in normal use.
  if (instanceSWRError && !instance) {
    // MaintenanceView is written for an administrator looking at a broken deployment: "Looks like
    // Plane didn't start up correctly … check your container logs", plus a mailto to Plane's
    // support. For the far more common failure — a phone with no usable connection — every word of
    // that is wrong, and it is the FIRST thing the app shows, because this wrapper sits above
    // routing (APLANE-36).
    //
    // `status === 0` is the whole distinction. Non-zero always means a real response arrived
    // (checked in axios 1.18.1: requestFailurePayload reads only `error.response.status`, the xhr
    // adapter always sets a numeric status, and settle resolves rather than rejects when there is
    // none) — a bodyless 502 is exactly what a stopped backend behind Caddy produces, so
    // MaintenanceView stays the right screen there and today's behaviour is unchanged.
    //
    // The converse is NOT true, and this is the honest limit of the branch: axios reports a
    // CORS-rejected answer, a mixed-content block and a TLS-intercepting proxy through the same
    // bodyless `onerror`, so a misconfigured origin also lands on `status: 0` and gets a Retry that
    // can never succeed. Nothing in the browser can tell those from a dead radio, and the radio is
    // the overwhelmingly common case on a phone.
    //
    // This failure object is the raw axios error: instance.service.getInstanceInfo is the one
    // service that rethrows `error` whole, so the payload sits at `.response.data`.
    // asRequestFailure finds it wherever it is.
    if (asRequestFailure(instanceSWRError)?.status === 0)
      return <ConnectionErrorView onRetry={() => void refetchInstanceInfo()} />;
    return <MaintenanceView />;
  }

  // something went wrong while in the request
  if (error && error?.status === "error") return <>{children}</>;

  // instance is not ready and setup is not done
  if (instance?.is_setup_done === false) return <InstanceNotReady />;

  return <>{children}</>;
});

export default InstanceWrapper;
