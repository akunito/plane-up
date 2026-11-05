/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * Run a secondary fetch of the work-item detail view without letting a failure become an
 * unhandled rejection (APLANE-29).
 *
 * `fetchIssue` deliberately does not await activities, comments, sub-issues, relations, states or
 * the parent item: the panel renders from the main work item and those sections fill in as they
 * arrive. Fire-and-forget with no catch is an unhandled rejection though, and when the work item
 * has just been deleted every one of them 404s at once, and an unhandled rejection is a real
 * defect regardless of who notices.
 *
 * CORRECTED 2026-11-05: this is NOT what made the iPhone E2E project fail. WebKit reports the abandoned load itself as a page error (verified: playwright-core turns any
 * javascript-source console error into one), which NO `.catch` can suppress — that symptom is
 * handled in the E2E guard, not here. These rejections are a separate, real latent defect:
 * worth fixing on their own merits, but they were never the cause of the L5 flake.
 *
 * Swallowing is all the call site can do: Plane's services throw `error.response.data`, so there is
 * no status here to tell "the item is gone" from "the server broke" (our pinned-entity.service.ts
 * keeps the status precisely because the sidebar has to make that distinction). The sections stay
 * empty, which is what they already did when one of these failed.
 *
 * Takes `unknown` on purpose: these store actions are not all typed as returning a promise, and a
 * `.catch` on a plain value would throw where the old code merely leaked a rejection.
 */
export const background = (result: unknown): void => {
  if (result instanceof Promise) result.catch(() => {});
};
