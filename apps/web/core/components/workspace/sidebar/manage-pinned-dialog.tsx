/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { ChevronDown, ChevronUp, FileText, Search, Ticket, X } from "lucide-react";
// plane imports
import { Logo } from "@plane/propel/emoji-icon-picker";
import type { IFavorite, IWorkspaceSearchResults } from "@plane/types";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// hooks
import { useFavorite } from "@/hooks/store/use-favorite";
import useDebounce from "@/hooks/use-debounce";
// services
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

/**
 * Manage popup for the sidebar "Pages" category: search + pin pages and tickets (work items),
 * and reorder / remove the already-pinned ones. Backed by the Favorites store (UserFavorite),
 * so pins persist server-side and sync across devices. entity_type "page" | "issue".
 */
export const ManagePinnedDialog = observer(function ManagePinnedDialog({ isOpen, onClose }: Props) {
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString();
  const { currentWorkspaceFavorites, addFavorite, deleteFavorite, updateFavorite } = useFavorite();

  // search state (one box per entity type; both hit the same workspace search endpoint)
  const [pageQuery, setPageQuery] = useState("");
  const [ticketQuery, setTicketQuery] = useState("");
  const debouncedPageQuery = useDebounce(pageQuery, 400);
  const debouncedTicketQuery = useDebounce(ticketQuery, 400);
  const [pageResults, setPageResults] = useState<IWorkspaceSearchResults["results"]["page"]>([]);
  const [ticketResults, setTicketResults] = useState<IWorkspaceSearchResults["results"]["issue"]>([]);

  // pinned items, split into the two groups (sorted by sequence desc, newest pins on top)
  const { pinnedPages, pinnedTickets, pinnedEntityIds } = useMemo(() => {
    const all = Object.values(currentWorkspaceFavorites).filter((f) => !f.parent);
    const bySeq = (a: IFavorite, b: IFavorite) => (b.sequence ?? 0) - (a.sequence ?? 0);
    const pages = all.filter((f) => f.entity_type === "page").sort(bySeq);
    const tickets = all.filter((f) => f.entity_type === "issue").sort(bySeq);
    const ids = new Set(all.map((f) => f.entity_identifier).filter(Boolean) as string[]);
    return { pinnedPages: pages, pinnedTickets: tickets, pinnedEntityIds: ids };
  }, [currentWorkspaceFavorites]);

  // --- search ---
  useEffect(() => {
    if (!slug || !debouncedPageQuery) return setPageResults([]);
    let active = true;
    workspaceService
      .searchWorkspace(slug, { search: debouncedPageQuery, workspace_search: true })
      .then((res: IWorkspaceSearchResults) => active && setPageResults(res?.results?.page ?? []))
      .catch(() => active && setPageResults([]));
    return () => {
      active = false;
    };
  }, [slug, debouncedPageQuery]);

  useEffect(() => {
    if (!slug || !debouncedTicketQuery) return setTicketResults([]);
    let active = true;
    workspaceService
      .searchWorkspace(slug, { search: debouncedTicketQuery, workspace_search: true })
      .then((res: IWorkspaceSearchResults) => active && setTicketResults(res?.results?.issue ?? []))
      .catch(() => active && setTicketResults([]));
    return () => {
      active = false;
    };
  }, [slug, debouncedTicketQuery]);

  // --- pin actions ---
  const pinPage = async (r: IWorkspaceSearchResults["results"]["page"][number]) => {
    if (!slug) return;
    await addFavorite(slug, {
      entity_type: "page",
      entity_identifier: r.id,
      project_id: r.project_ids?.[0] ?? null,
      name: r.name,
      entity_data: { name: r.name },
    });
    setPageQuery("");
    setPageResults([]);
  };

  const pinTicket = async (r: IWorkspaceSearchResults["results"]["issue"][number]) => {
    if (!slug) return;
    const label = `${r.project__identifier}-${r.sequence_id} ${r.name}`;
    await addFavorite(slug, {
      entity_type: "issue",
      entity_identifier: r.id,
      project_id: r.project_id,
      name: label,
      entity_data: { name: label },
    });
    setTicketQuery("");
    setTicketResults([]);
  };

  // --- reorder (swap sequence with the adjacent item) & remove ---
  const move = async (list: IFavorite[], index: number, dir: -1 | 1) => {
    if (!slug) return;
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[index];
    const b = list[j];
    await Promise.all([
      updateFavorite(slug, a.id, { sequence: b.sequence }),
      updateFavorite(slug, b.id, { sequence: a.sequence }),
    ]);
  };

  const remove = async (favoriteId: string) => {
    if (!slug) return;
    await deleteFavorite(slug, favoriteId);
  };

  const renderSection = (
    kind: "page" | "issue",
    query: string,
    setQuery: (v: string) => void,
    results: { id: string; name: string }[],
    pinned: IFavorite[],
    onPin: (r: any) => void
  ) => {
    const Icon = kind === "page" ? FileText : Ticket;
    const label = kind === "page" ? "Pages" : "Tickets";
    const placeholder = kind === "page" ? "Search pages to pin…" : "Search tickets to pin…";
    const visibleResults = results.filter((r) => !pinnedEntityIds.has(r.id)).slice(0, 8);
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2 text-13 font-semibold text-primary">
          <Icon className="size-4 text-tertiary" />
          {label}
        </div>
        {/* search */}
        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-md border border-subtle bg-surface-2 py-1.5 pl-8 pr-2 text-13 text-primary outline-none placeholder:text-tertiary focus:border-accent-primary"
            />
          </div>
          {/* results render inline (not absolutely positioned) so they aren't clipped by the modal's
              scroll container — the modal body scrolls to reveal them. */}
          {visibleResults.length > 0 && (
            <div className="mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-subtle bg-surface-1">
              {visibleResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onPin(r)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-13 text-secondary hover:bg-layer-1"
                >
                  <Icon className="size-3.5 flex-shrink-0 text-tertiary" />
                  <span className="truncate">
                    {kind === "issue"
                      ? `${(r as any).project__identifier}-${(r as any).sequence_id} ${r.name}`
                      : r.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* pinned list */}
        <div className="mt-3 flex flex-col gap-1">
          {pinned.length === 0 && (
            <span className="px-1 py-2 text-12 text-tertiary">No pinned {label.toLowerCase()} yet.</span>
          )}
          {pinned.map((fav, index) => (
            <div
              key={fav.id}
              className="group flex items-center gap-2 rounded-md border border-subtle bg-surface-2 px-2 py-1.5"
            >
              {kind === "page" && fav.entity_data?.logo_props ? (
                <Logo logo={fav.entity_data.logo_props} size={14} />
              ) : (
                <Icon className="size-3.5 flex-shrink-0 text-tertiary" />
              )}
              <span className="flex-1 truncate text-13 text-secondary">{fav.entity_data?.name ?? fav.name}</span>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => move(pinned, index, -1)}
                className="text-tertiary hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                aria-label="Move up"
              >
                <ChevronUp className="size-4" />
              </button>
              <button
                type="button"
                disabled={index === pinned.length - 1}
                onClick={() => move(pinned, index, 1)}
                className="text-tertiary hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                aria-label="Move down"
              >
                <ChevronDown className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => remove(fav.id)}
                className="text-tertiary hover:text-danger-text"
                aria-label="Remove"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <div className="flex max-h-[85vh] flex-col bg-surface-1">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-subtle px-5 py-4">
          <div>
            <h3 className="text-15 font-semibold text-primary">Manage pinned items</h3>
            <p className="mt-0.5 text-12 text-tertiary">Pin pages and tickets to the sidebar for quick access.</p>
          </div>
          <button type="button" onClick={onClose} className="text-tertiary hover:text-primary" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex flex-col gap-6 overflow-y-auto p-5 sm:flex-row">
          {renderSection("page", pageQuery, setPageQuery, pageResults, pinnedPages, pinPage)}
          {renderSection("issue", ticketQuery, setTicketQuery, ticketResults, pinnedTickets, pinTicket)}
        </div>
      </div>
    </ModalCore>
  );
});
