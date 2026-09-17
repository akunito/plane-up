/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import useSWR from "swr";
import type { IFavorite } from "@plane/types";
import { generateWorkItemLink } from "@plane/utils";
// hooks
import { useFavorite } from "@/hooks/store/use-favorite";
import { useProject } from "@/hooks/store/use-project";
// services
import { PinnedEntityService } from "@/services/pinned-entity.service";

const pinnedEntityService = new PinnedEntityService();

export type TPinnedEntity = {
  favoriteId: string;
  entityType: "page" | "issue";
  entityId: string;
  projectId: string;
  /** live title, never the label stored when it was pinned */
  name: string;
  /** work items only: "QAA-12", from the project's current identifier */
  label?: string;
  href: string;
  isArchived: boolean;
};

/**
 * Resolves the sidebar's pins from their UUIDs (B-08…B-10, APLANE-13).
 *
 * The label stored at pin time went stale on a rename and broke the link when a project's
 * identifier changed, so every pin is read from the API instead:
 *  - deleted (404)          → the favourite is removed, here and for every other device
 *  - no access (401/403)    → hidden, never deleted: it comes back if access does
 *  - archived               → kept, opening its archived route
 *  - anything else (5xx…)   → kept with the last known label, so a blip doesn't drop pins
 */
type TResolved = TPinnedEntity | { drop: string } | null;

export const usePinnedEntities = (workspaceSlug: string | undefined) => {
  const { currentWorkspaceFavorites, deleteFavorite } = useFavorite();
  const { getProjectIdentifierById } = useProject();

  const favourites = useMemo(
    () =>
      Object.values(currentWorkspaceFavorites)
        .filter((f) => !f.parent && (f.entity_type === "page" || f.entity_type === "issue") && f.entity_identifier)
        .sort((a: IFavorite, b: IFavorite) => (b.sequence ?? 0) - (a.sequence ?? 0)),
    [currentWorkspaceFavorites]
  );

  const cacheKey = workspaceSlug
    ? `PINNED_ENTITIES_${workspaceSlug}_${favourites.map((f) => `${f.entity_type}:${f.entity_identifier}`).join(",")}`
    : null;

  const { data, isLoading } = useSWR(
    cacheKey,
    async (): Promise<TPinnedEntity[]> => {
      const slug = workspaceSlug;
      if (!slug) return [];
      const resolved: TResolved[] = await Promise.all(
        favourites.map(async (favourite): Promise<TResolved> => {
          const projectId = favourite.project_id ?? "";
          const entityId = favourite.entity_identifier ?? "";
          if (!projectId || !entityId) return null;

          if (favourite.entity_type === "page") {
            const { status, data: page } = await pinnedEntityService.fetchPage(slug, projectId, entityId);
            if (status === 404) return { drop: favourite.id };
            if (status === 401 || status === 403) return null;
            const name = page?.name || favourite.entity_data?.name || favourite.name || "Untitled";
            return {
              favoriteId: favourite.id,
              entityType: "page" as const,
              entityId,
              projectId,
              name,
              href: `/${slug}/projects/${projectId}/pages/${entityId}`,
              isArchived: !!page?.archived_at,
            };
          }

          const { status, data: workItem } = await pinnedEntityService.fetchWorkItem(slug, projectId, entityId);
          if (status === 404) return { drop: favourite.id };
          if (status === 401 || status === 403) return null;
          const identifier = getProjectIdentifierById(projectId);
          const name = workItem?.name || favourite.entity_data?.name || favourite.name || "Untitled";
          return {
            favoriteId: favourite.id,
            entityType: "issue" as const,
            entityId,
            projectId,
            name,
            label: workItem?.sequence_id && identifier ? `${identifier}-${workItem.sequence_id}` : undefined,
            href: generateWorkItemLink({
              workspaceSlug: slug,
              projectId,
              issueId: entityId,
              projectIdentifier: identifier,
              sequenceId: workItem?.sequence_id,
              isArchived: !!workItem?.archived_at,
            }),
            isArchived: !!workItem?.archived_at,
          };
        })
      );

      // gone for good: take the pin with it (server-side, so every device agrees)
      for (const entry of resolved) {
        // deleteFavorite removes it from the store as well
        if (entry && "drop" in entry) await deleteFavorite(slug, entry.drop).catch(() => {});
      }
      return resolved.filter((entry: TResolved): entry is TPinnedEntity => !!entry && !("drop" in entry));
    },
    { revalidateOnFocus: false }
  );

  const entities = data ?? [];
  return {
    pages: entities.filter((e) => e.entityType === "page"),
    tickets: entities.filter((e) => e.entityType === "issue"),
    isLoading: isLoading && favourites.length > 0,
    hasFavourites: favourites.length > 0,
  };
};
