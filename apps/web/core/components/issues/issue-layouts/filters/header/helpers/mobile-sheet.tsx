/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

/**
 * Mobile bottom-sheet wrapper for the filter/display popovers. On phones these
 * render as a full-width sheet docked to the bottom (via ModalCore CENTER =
 * `items-end` on mobile) with a drag-handle bar + a "Done" close, instead of the
 * desktop popper dropdown. Tap-out / Esc close are handled by ModalCore.
 */
export function FilterMobileSheet({ isOpen, onClose, title, children }: Props) {
  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XL}>
      <div className="flex max-h-[85vh] flex-col rounded-t-xl bg-surface-1">
        {/* drag handle */}
        <div className="mx-auto mt-2 mb-1 h-1 w-10 flex-shrink-0 rounded-full bg-border-strong" />
        <div className="flex flex-shrink-0 items-center justify-between px-4 pt-1 pb-2">
          <span className="text-14 font-semibold text-primary">{title ?? ""}</span>
          <button type="button" onClick={onClose} className="text-13 font-medium text-accent-primary">
            Done
          </button>
        </div>
        <div className="flex flex-col overflow-y-auto pb-2">{children}</div>
      </div>
    </ModalCore>
  );
}
