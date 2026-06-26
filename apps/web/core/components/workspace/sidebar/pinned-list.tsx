/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { FileText, Pin, Ticket } from "lucide-react";
import { Disclosure, Transition } from "@headlessui/react";
// plane imports
import { ChevronRightIcon } from "@plane/propel/icons";
import { IconButton } from "@plane/propel/icon-button";
import { Logo } from "@plane/propel/emoji-icon-picker";
import { Tooltip } from "@plane/propel/tooltip";
import type { IFavorite } from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useFavorite } from "@/hooks/store/use-favorite";
import { useAppRouter } from "@/hooks/use-app-router";
import useIssuePeekOverviewRedirection from "@/hooks/use-issue-peek-overview-redirection";
import useLocalStorage from "@/hooks/use-local-storage";
import { usePlatformOS } from "@/hooks/use-platform-os";
// local
import { ManagePinnedDialog } from "./manage-pinned-dialog";

/**
 * Sidebar "Pages" category: quick-access pins for pages + tickets (work items), backed by the
 * Favorites store (entity_type "page" | "issue"). Two groups (Pages / Tickets), each sorted by
 * sequence desc. A manage popup (pin icon) handles search/add/reorder/remove. Pages open their
 * route; tickets open the peek overlay.
 */
export const SidebarPinnedList = observer(function SidebarPinnedList() {
  // state
  const [isManageOpen, setIsManageOpen] = useState(false);
  const { setValue: toggleOpen, storedValue: isOpen } = useLocalStorage<boolean>("is_pinned_menu_open", true);
  // store
  const { currentWorkspaceFavorites } = useFavorite();
  const { workspaceSlug } = useParams();
  const router = useAppRouter();
  const { handleRedirection } = useIssuePeekOverviewRedirection();
  const { isMobile } = usePlatformOS();

  const { pages, tickets } = useMemo(() => {
    const all = Object.values(currentWorkspaceFavorites).filter((f) => !f.parent);
    const bySeq = (a: IFavorite, b: IFavorite) => (b.sequence ?? 0) - (a.sequence ?? 0);
    return {
      pages: all.filter((f) => f.entity_type === "page").sort(bySeq),
      tickets: all.filter((f) => f.entity_type === "issue").sort(bySeq),
    };
  }, [currentWorkspaceFavorites]);

  const openPage = (fav: IFavorite) => {
    if (!workspaceSlug || !fav.project_id || !fav.entity_identifier) return;
    router.push(`/${workspaceSlug}/projects/${fav.project_id}/pages/${fav.entity_identifier}`);
  };

  const openTicket = (fav: IFavorite) => {
    if (!workspaceSlug || !fav.entity_identifier) return;
    handleRedirection(
      workspaceSlug.toString(),
      // minimal issue shape — handleRedirection only needs id + project_id (peek on desktop / page on mobile)
      { id: fav.entity_identifier, project_id: fav.project_id } as any,
      isMobile
    );
  };

  const rowClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-13 text-secondary hover:bg-layer-transparent-hover";

  const groupLabelClass = "px-2 pb-0.5 pt-1.5 text-11 font-medium uppercase tracking-wide text-tertiary";

  return (
    <>
      <ManagePinnedDialog isOpen={isManageOpen} onClose={() => setIsManageOpen(false)} />
      <Disclosure as="div" className="flex flex-col" defaultOpen={!!isOpen}>
        <div className="group flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-placeholder hover:bg-layer-transparent-hover">
          <Disclosure.Button
            as="button"
            type="button"
            className="flex w-full items-center gap-1 text-left text-13 font-semibold whitespace-nowrap text-placeholder"
            onClick={() => toggleOpen(!isOpen)}
          >
            <span className="text-13 font-semibold">Pages</span>
          </Disclosure.Button>
          <div className="flex items-center gap-1">
            <Tooltip tooltipHeading="Manage pinned items" tooltipContent="">
              <IconButton
                variant="ghost"
                size="sm"
                icon={Pin}
                onClick={() => setIsManageOpen(true)}
                className="inline-flex text-placeholder md:hidden md:group-hover:inline-flex"
                aria-label="Manage pinned items"
              />
            </Tooltip>
            <IconButton
              variant="ghost"
              size="sm"
              icon={ChevronRightIcon}
              onClick={() => toggleOpen(!isOpen)}
              className="inline-flex text-placeholder md:hidden md:group-hover:inline-flex"
              iconClassName={cn("transition-transform", { "rotate-90": isOpen })}
              aria-label="Toggle pinned menu"
            />
          </div>
        </div>
        <Transition
          show={!!isOpen}
          enter="transition duration-100 ease-out"
          enterFrom="transform scale-95 opacity-0"
          enterTo="transform scale-100 opacity-100"
          leave="transition duration-75 ease-out"
          leaveFrom="transform scale-100 opacity-100"
          leaveTo="transform scale-95 opacity-0"
        >
          {isOpen && (
            <Disclosure.Panel as="div" className="flex flex-col gap-0.5" static>
              {pages.length === 0 && tickets.length === 0 && (
                <button
                  type="button"
                  onClick={() => setIsManageOpen(true)}
                  className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-13 text-placeholder hover:bg-layer-transparent-hover"
                >
                  <Pin className="size-3.5" /> Pin pages or tickets
                </button>
              )}

              {pages.length > 0 && (
                <>
                  <div className={groupLabelClass}>Pages</div>
                  {pages.map((fav) => (
                    <button key={fav.id} type="button" className={rowClass} onClick={() => openPage(fav)}>
                      {fav.entity_data?.logo_props ? (
                        <Logo logo={fav.entity_data.logo_props} size={14} />
                      ) : (
                        <FileText className="size-3.5 flex-shrink-0 text-tertiary" />
                      )}
                      <span className="truncate">{fav.entity_data?.name ?? fav.name}</span>
                    </button>
                  ))}
                </>
              )}

              {tickets.length > 0 && (
                <>
                  <div className={groupLabelClass}>Tickets</div>
                  {tickets.map((fav) => (
                    <button key={fav.id} type="button" className={rowClass} onClick={() => openTicket(fav)}>
                      <Ticket className="size-3.5 flex-shrink-0 text-tertiary" />
                      <span className="truncate">{fav.entity_data?.name ?? fav.name}</span>
                    </button>
                  ))}
                </>
              )}
            </Disclosure.Panel>
          )}
        </Transition>
      </Disclosure>
    </>
  );
});
