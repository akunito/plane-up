/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Fingerprint, KeyRound, Mails } from "lucide-react";
// types
import type {
  TCoreInstanceAuthenticationModeKeys,
  TGetBaseAuthenticationModeProps,
  TInstanceAuthenticationModes,
} from "@plane/types";
// assets
import githubLightModeImage from "@/app/assets/logos/github-black.png?url";
import githubDarkModeImage from "@/app/assets/logos/github-white.png?url";
import gitlabLogo from "@/app/assets/logos/gitlab-logo.svg?url";
import googleLogo from "@/app/assets/logos/google-logo.svg?url";
// components
import { EmailCodesConfiguration } from "@/components/authentication/email-config-switch";
import { GiteaConfiguration } from "@/components/authentication/gitea-config";
import { GithubConfiguration } from "@/components/authentication/github-config";
import { GitlabConfiguration } from "@/components/authentication/gitlab-config";
import { GoogleConfiguration } from "@/components/authentication/google-config";
import { PasswordLoginConfiguration } from "@/components/authentication/password-config-switch";

// Authentication methods
export const getCoreAuthenticationModesMap: (
  props: TGetBaseAuthenticationModeProps
) => Record<TCoreInstanceAuthenticationModeKeys, TInstanceAuthenticationModes> = ({
  disabled,
  updateConfig,
  resolvedTheme,
}) => ({
  "unique-codes": {
    key: "unique-codes",
    name: "Unique codes",
    description:
      "Log in or sign up for Plane using codes sent via email. You need to have set up SMTP to use this method.",
    icon: <Mails className="h-6 w-6 p-0.5 text-tertiary" />,
    config: <EmailCodesConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "ENABLE_MAGIC_LINK_LOGIN",
  },
  "passwords-login": {
    key: "passwords-login",
    name: "Passwords",
    description: "Allow members to create accounts with passwords and use it with their email addresses to sign in.",
    icon: <KeyRound className="h-6 w-6 p-0.5 text-tertiary" />,
    config: <PasswordLoginConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "ENABLE_EMAIL_PASSWORD",
  },
  google: {
    key: "google",
    name: "Google",
    description: "Allow members to log in or sign up for Plane with their Google accounts.",
    icon: <img src={googleLogo} height={20} width={20} alt="Google Logo" />,
    config: <GoogleConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "IS_GOOGLE_ENABLED",
  },
  github: {
    key: "github",
    name: "GitHub",
    description: "Allow members to log in or sign up for Plane with their GitHub accounts.",
    icon: (
      <img
        src={resolvedTheme === "dark" ? githubDarkModeImage : githubLightModeImage}
        height={20}
        width={20}
        alt="GitHub Logo"
      />
    ),
    config: <GithubConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "IS_GITHUB_ENABLED",
  },
  gitlab: {
    key: "gitlab",
    name: "GitLab",
    description: "Allow members to log in or sign up to plane with their GitLab accounts.",
    icon: <img src={gitlabLogo} height={20} width={20} alt="GitLab Logo" />,
    config: <GitlabConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "IS_GITLAB_ENABLED",
  },
  gitea: {
    // Repurposed "gitea" OAuth slot: the adapter talks to Pocket ID OIDC
    // (apps/api/plane/authentication/provider/oauth/gitea.py). The key, the route and the
    // IS_GITEA_ENABLED row stay as they are; everything an admin READS here is Pocket ID.
    // The icon is replaced, not just its alt text: relabelling the name while still rendering
    // gitea-logo.svg would leave the admin looking at the Gitea logo, which is the half of this
    // bug a text-only assertion misses (measured on the APLANE-45 e2e test, where getByText
    // passed over an `alt="Gitea Logo"`). lucide's Fingerprint is the same glyph apps/web and
    // apps/space inline for this slot.
    key: "gitea",
    name: "Pocket ID",
    description: "Allow members to log in or sign up to plane with their Pocket ID accounts.",
    icon: <Fingerprint size={20} role="img" aria-label="Pocket ID" />,
    config: <GiteaConfiguration disabled={disabled} updateConfig={updateConfig} />,
    enabledConfigKey: "IS_GITEA_ENABLED",
  },
});
