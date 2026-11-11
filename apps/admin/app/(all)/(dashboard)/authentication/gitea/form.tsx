/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { isEmpty } from "lodash-es";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
// plane internal packages
import { API_BASE_URL } from "@plane/constants";
import { Button, getButtonStyling } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IFormattedInstanceConfiguration, TInstanceGiteaAuthenticationConfigurationKeys } from "@plane/types";
// components
import { CodeBlock } from "@/components/common/code-block";
import { ConfirmDiscardModal } from "@/components/common/confirm-discard-modal";
import type { TControllerInputFormField } from "@/components/common/controller-input";
import { ControllerInput } from "@/components/common/controller-input";
import type { TControllerSwitchFormField } from "@/components/common/controller-switch";
import { ControllerSwitch } from "@/components/common/controller-switch";
import type { TCopyField } from "@/components/common/copy-field";
import { CopyField } from "@/components/common/copy-field";
// hooks
import { useInstance } from "@/hooks/store";

type Props = {
  config: IFormattedInstanceConfiguration;
};

type GiteaConfigFormValues = Record<TInstanceGiteaAuthenticationConfigurationKeys, string>;

// Every GITEA_* key here is load-bearing and stays: the instance configuration rows, the
// /auth/gitea/ routes and every existing user's provider_id key off that name, so renaming the slot
// would log the whole instance out (apps/api/plane/authentication/provider/oauth/gitea.py). What an
// admin READS is another matter — this form configures Pocket ID OIDC, and until APLANE-49 it
// described Gitea, defaulted the host to https://gitea.com and sent admins to gitea.com for
// credentials that do not exist there.
const GITEA_FORM_SWITCH_FIELD: TControllerSwitchFormField<GiteaConfigFormValues> = {
  name: "ENABLE_GITEA_SYNC",
  label: "Pocket ID",
};

export function InstanceGiteaConfigForm(props: Props) {
  const { config } = props;
  // states
  const [isDiscardChangesModalOpen, setIsDiscardChangesModalOpen] = useState(false);
  // store hooks
  const { updateInstanceConfigurations } = useInstance();
  // form data
  const {
    handleSubmit,
    control,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<GiteaConfigFormValues>({
    defaultValues: {
      // No fallback. Upstream prefilled "https://gitea.com", so an admin who saved this form
      // without touching the field pointed the OIDC flow at the wrong provider. The field is
      // `required` (a real rule — controller-input.tsx:49), so an empty default makes the form ask
      // instead of guessing. It does NOT make the field safe: nothing here checks the scheme, so a
      // saved "auth.example.com" still fails at login as GITEA_NOT_CONFIGURED with nothing in the
      // UI to explain it. Narrower than it looks, and left that way on purpose — a pattern rule
      // means changing the shared ControllerInput every auth form uses.
      GITEA_HOST: config["GITEA_HOST"] || "",
      GITEA_CLIENT_ID: config["GITEA_CLIENT_ID"],
      GITEA_CLIENT_SECRET: config["GITEA_CLIENT_SECRET"],
      ENABLE_GITEA_SYNC: config["ENABLE_GITEA_SYNC"] || "0",
    },
  });

  const originURL = !isEmpty(API_BASE_URL) ? API_BASE_URL : typeof window !== "undefined" ? window.location.origin : "";

  // Three descriptions point at the same place, so it is built once. Deliberately NOT a deep link:
  // Pocket ID's OIDC-client page has moved between versions and an unverified path would be a dead
  // link in an admin panel, so this links the configured host and names the nav path in prose.
  //
  // `useWatch`, NOT the `control._formValues` read upstream used for its single link. That read has
  // no subscription: this component subscribes to errors/isDirty/isSubmitting only and the
  // validation mode is the default onSubmit, so typing a host re-renders exactly ONCE — the first
  // keystroke, when isDirty flips false -> true. The links would have frozen at that one character.
  // Upstream never noticed because its fallback was a literal gitea.com; with the fallback gone it
  // would have rendered href="h", a RELATIVE url resolving against the admin app, which is the dead
  // link this whole block exists to avoid.
  const host = (useWatch({ control, name: "GITEA_HOST" }) || "").trim().replace(/\/+$/, "");
  // Only an absolute http(s) url becomes a link, for the same reason: "auth.example.com" with no
  // scheme is a relative href. The adapter rejects a scheme-less host too
  // (gitea.py:59-64, GITEA_NOT_CONFIGURED), and the form cannot enforce it — the shared
  // ControllerInput hardcodes `rules={{ required }}` and accepts no pattern
  // (controller-input.tsx:49), so the link going plain is the only hint the field is unusable.
  const pocketIdHost = /^https?:\/\/\S+$/.test(host) ? host : "";
  const oidcClientsLink = pocketIdHost ? (
    <a
      href={pocketIdHost}
      target="_blank"
      className="text-accent-primary hover:underline"
      rel="noreferrer"
      aria-label="Pocket ID OIDC client settings"
    >
      Administration &rarr; OIDC Clients
    </a>
  ) : (
    <>Administration &rarr; OIDC Clients</>
  );

  const GITEA_FORM_FIELDS: TControllerInputFormField[] = [
    {
      key: "GITEA_HOST",
      type: "text",
      label: "Pocket ID Host",
      description: (
        <>
          The base URL of your Pocket ID instance, with no trailing path — the adapter appends{" "}
          <CodeBlock darkerShade>/authorize</CodeBlock> and <CodeBlock darkerShade>/api/oidc/*</CodeBlock> itself.
        </>
      ),
      placeholder: "https://auth.example.com",
      error: Boolean(errors.GITEA_HOST),
      required: true,
    },
    {
      key: "GITEA_CLIENT_ID",
      type: "text",
      label: "Client ID",
      description: (
        <>
          Pocket ID generates this when you save the OIDC client: {oidcClientsLink}. This adapter exchanges the code
          with a client secret and sends no PKCE challenge, so create a confidential client — in Pocket ID, leave{" "}
          <CodeBlock darkerShade>Public Client</CodeBlock> off.
        </>
      ),
      placeholder: "70a44354520df8bd9bcd",
      error: Boolean(errors.GITEA_CLIENT_ID),
      required: true,
    },
    {
      key: "GITEA_CLIENT_SECRET",
      type: "password",
      label: "Client secret",
      description: (
        <>
          Shown once, right after you save the OIDC client in {oidcClientsLink} — copy it then. If you lost it, generate
          a new secret there and paste it here.
        </>
      ),
      placeholder: "9b0050f94ec1b744e32ce79ea4ffacd40d4119cb",
      error: Boolean(errors.GITEA_CLIENT_SECRET),
      required: true,
    },
  ];

  const GITEA_SERVICE_FIELD: TCopyField[] = [
    {
      key: "Callback_URI",
      label: "Callback URI",
      url: `${originURL}/auth/gitea/callback/`,
      description: (
        <>
          We will auto-generate this. Paste it into the <CodeBlock darkerShade>Callback URL</CodeBlock> field of
          Plane&apos;s OIDC client in {oidcClientsLink}. The path stays{" "}
          <CodeBlock darkerShade>/auth/gitea/callback/</CodeBlock> — that is the route name, not the provider.
        </>
      ),
    },
  ];

  const onSubmit = async (formData: GiteaConfigFormValues) => {
    const payload: Partial<GiteaConfigFormValues> = { ...formData };

    try {
      const response = await updateInstanceConfigurations(payload);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Done!",
        message: "Your Pocket ID authentication is configured. You should test it now.",
      });
      reset({
        GITEA_HOST: response.find((item) => item.key === "GITEA_HOST")?.value,
        GITEA_CLIENT_ID: response.find((item) => item.key === "GITEA_CLIENT_ID")?.value,
        GITEA_CLIENT_SECRET: response.find((item) => item.key === "GITEA_CLIENT_SECRET")?.value,
        ENABLE_GITEA_SYNC: response.find((item) => item.key === "ENABLE_GITEA_SYNC")?.value,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleGoBack = (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
    if (isDirty) {
      e.preventDefault();
      setIsDiscardChangesModalOpen(true);
    }
  };

  return (
    <>
      <ConfirmDiscardModal
        isOpen={isDiscardChangesModalOpen}
        onDiscardHref="/authentication"
        handleClose={() => setIsDiscardChangesModalOpen(false)}
      />
      <div className="flex flex-col gap-8">
        <div className="grid w-full grid-cols-2 gap-x-12 gap-y-8">
          <div className="col-span-2 flex flex-col gap-y-4 pt-1 md:col-span-1">
            <div className="pt-2.5 text-18 font-medium">Pocket-ID-provided details for Plane</div>
            {GITEA_FORM_FIELDS.map((field) => (
              <ControllerInput
                key={field.key}
                control={control}
                type={field.type}
                name={field.key}
                label={field.label}
                description={field.description}
                placeholder={field.placeholder}
                error={field.error}
                required={field.required}
              />
            ))}
            <ControllerSwitch control={control} field={GITEA_FORM_SWITCH_FIELD} />
            <div className="flex flex-col gap-1 pt-4">
              <div className="flex items-center gap-4">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={(e) => void handleSubmit(onSubmit)(e)}
                  loading={isSubmitting}
                  disabled={!isDirty}
                >
                  {isSubmitting ? "Saving" : "Save changes"}
                </Button>
                <Link href="/authentication" className={getButtonStyling("secondary", "lg")} onClick={handleGoBack}>
                  Go back
                </Link>
              </div>
            </div>
          </div>
          <div className="col-span-2 md:col-span-1">
            <div className="flex flex-col gap-y-4 rounded-lg bg-layer-1 px-6 pt-1.5 pb-4">
              <div className="pt-2 text-18 font-medium">Plane-provided details for Pocket ID</div>
              {GITEA_SERVICE_FIELD.map((field) => (
                <CopyField key={field.key} label={field.label} url={field.url} description={field.description} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
