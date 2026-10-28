/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { addDays } from "date-fns";
// ui
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Calendar } from "@plane/propel/calendar";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

export type InboxIssueSnoozeModalProps = {
  isOpen: boolean;
  value: Date | undefined;
  projectTimezone: string | undefined;
  onConfirm: (value: Date) => void;
  handleClose: () => void;
};

// `date`'s calendar day in `timeZone` (browser zone if unset), as a local-midnight Date (what the calendar compares against).
export const getDayInTimezone = (date: Date, timeZone: string | undefined) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(part("year"), part("month") - 1, part("day"));
};

export function InboxIssueSnoozeModal(props: InboxIssueSnoozeModalProps) {
  const { isOpen, handleClose, value, projectTimezone, onConfirm } = props;
  // states
  const [pickedDate, setPickedDate] = useState<Date | undefined>();
  //hooks
  const { t } = useTranslation();
  // derived values
  // A snooze ends at 00:00 of the picked day in the project timezone, so any day that has already
  // started there would lapse at once. The pick is cleared on close because this modal stays
  // mounted across intake items.
  const tomorrow = addDays(getDayInTimezone(new Date(), projectTimezone), 1);
  const snoozedDay = value ? getDayInTimezone(new Date(value), projectTimezone) : undefined;
  const date = pickedDate ?? (snoozedDay && snoozedDay >= tomorrow ? snoozedDay : tomorrow);

  const onClose = () => {
    setPickedDate(undefined);
    handleClose();
  };

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={onClose}
      position={EModalPosition.CENTER}
      width={EModalWidth.SM}
      className="w-auto"
    >
      <div className="flex h-full w-full flex-col gap-y-1 px-5 py-8 sm:p-6">
        <Calendar
          className="rounded-md border border-subtle p-3"
          captionLayout="dropdown"
          selected={date}
          defaultMonth={date}
          onSelect={(selected: Date | undefined) => {
            if (!selected) return;
            setPickedDate(selected);
          }}
          mode="single"
          disabled={[
            {
              before: tomorrow,
            },
          ]}
        />
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            onConfirm(date);
          }}
        >
          {t("inbox_issue.actions.snooze")}
        </Button>
      </div>
    </ModalCore>
  );
}
