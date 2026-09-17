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
import { cn } from "@plane/utils";
// hooks
import { useAppRouter } from "@/hooks/use-app-router";
import useLocalStorage from "@/hooks/use-local-storage";
import { usePinnedEntities } from "@/hooks/use-pinned-entities";
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
  const { workspaceSlug } = useParams();
  const router = useAppRouter();
  // Pins are resolved from their UUIDs: live titles and identifiers, deleted ones dropped,
  // ones this user can no longer open hidden (see usePinnedEntities).
  const { pages, tickets, hasFavourites } = usePinnedEntities(workspaceSlug?.toString());

  const rowClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-13 text-secondary hover:bg-layer-transparent-hover";

  const groupLabelClass = "px-2 pb-0.5 pt-1.5 text-11 font-medium uppercase tracking-wide text-tertiary";
  const isEmpty = !hasFavourites || (pages.length === 0 && tickets.length === 0);

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
            <span className="text-13 font-semibold">Pins</span>
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
              {isEmpty && (
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
                  {pages.map((pin) => (
                    <button
                      key={pin.favoriteId}
                      type="button"
                      className={rowClass}
                      onClick={() => router.push(pin.href)}
                    >
                      <FileText className="size-3.5 flex-shrink-0 text-tertiary" />
                      <span className="truncate">{pin.name}</span>
                    </button>
                  ))}
                </>
              )}

              {tickets.length > 0 && (
                <>
                  <div className={groupLabelClass}>Tickets</div>
                  {tickets.map((pin) => (
                    <button
                      key={pin.favoriteId}
                      type="button"
                      className={rowClass}
                      onClick={() => router.push(pin.href)}
                    >
                      <Ticket className="size-3.5 flex-shrink-0 text-tertiary" />
                      <span className="truncate">{pin.label ? `${pin.label} ${pin.name}` : pin.name}</span>
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
