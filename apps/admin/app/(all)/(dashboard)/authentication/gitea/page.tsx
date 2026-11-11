/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// icons
import { Fingerprint } from "lucide-react";
// plane internal packages
import { setPromiseToast } from "@plane/propel/toast";
import { Loader, ToggleSwitch } from "@plane/ui";
// components
import { AuthenticationMethodCard } from "@/components/authentication/authentication-method-card";
import { PageWrapper } from "@/components/common/page-wrapper";
// hooks
import { useInstance } from "@/hooks/store";
// types
import type { Route } from "./+types/page";
// local
import { InstanceGiteaConfigForm } from "./form";

const InstanceGiteaAuthenticationPage = observer(function InstanceGiteaAuthenticationPage() {
  // store
  const { fetchInstanceConfigurations, formattedConfig, updateInstanceConfigurations } = useInstance();
  // state
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  // config
  const enableGiteaConfig = formattedConfig?.IS_GITEA_ENABLED ?? "";
  useSWR("INSTANCE_CONFIGURATIONS", () => fetchInstanceConfigurations());

  const updateConfig = async (key: "IS_GITEA_ENABLED", value: string) => {
    setIsSubmitting(true);

    const payload = {
      [key]: value,
    };

    const updateConfigPromise = updateInstanceConfigurations(payload);

    setPromiseToast(updateConfigPromise, {
      loading: "Saving Configuration",
      success: {
        title: "Configuration saved",
        message: () => `Pocket ID authentication is now ${value === "1" ? "active" : "disabled"}.`,
      },
      error: {
        title: "Error",
        message: () => "Failed to save configuration",
      },
    });

    await updateConfigPromise
      .then(() => {
        setIsSubmitting(false);
      })
      .catch((err) => {
        console.error(err);
        setIsSubmitting(false);
      });
  };

  const isGiteaEnabled = enableGiteaConfig === "1";

  return (
    <PageWrapper
      customHeader={
        <AuthenticationMethodCard
          name="Pocket ID"
          description="Allow members to login or sign up to plane with their Pocket ID accounts."
          icon={<Fingerprint size={24} role="img" aria-label="Pocket ID" />}
          config={
            <ToggleSwitch
              value={isGiteaEnabled}
              onChange={() => {
                updateConfig("IS_GITEA_ENABLED", isGiteaEnabled ? "0" : "1");
              }}
              size="sm"
              disabled={isSubmitting || !formattedConfig}
            />
          }
          disabled={isSubmitting || !formattedConfig}
          withBorder={false}
        />
      }
    >
      {formattedConfig ? (
        <InstanceGiteaConfigForm config={formattedConfig} />
      ) : (
        <Loader className="space-y-8">
          <Loader.Item height="50px" width="25%" />
          <Loader.Item height="50px" />
          <Loader.Item height="50px" />
          <Loader.Item height="50px" />
          <Loader.Item height="50px" width="50%" />
        </Loader>
      )}
    </PageWrapper>
  );
});
export const meta: Route.MetaFunction = () => [{ title: "Pocket ID Authentication - God Mode" }];

export default InstanceGiteaAuthenticationPage;
