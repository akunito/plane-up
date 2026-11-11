/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TCoreLoginMediums } from "@plane/types";

export const CORE_LOGIN_MEDIUM_LABELS: Record<TCoreLoginMediums, string> = {
  email: "Email",
  "magic-code": "Magic code",
  github: "GitHub",
  gitlab: "GitLab",
  google: "Google",
  // The "gitea" slot is repurposed Pocket ID OIDC, not Gitea — the key is load-bearing (routes,
  // GITEA_* config rows, every user's provider_id) but the LABEL is user-facing: this is what the
  // workspace members table prints as a member's login medium
  // (apps/web/core/components/workspace/settings/useMemberColumns.tsx:118). B-32 relabelled the
  // login button only, so the members table went on naming a provider this fork does not use.
  gitea: "Pocket ID",
};
