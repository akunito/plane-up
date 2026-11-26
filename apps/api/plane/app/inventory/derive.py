# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# The derived to-buy rule (brief: Item state, Orders). The TypeScript package reads the same fixture
# (plane/tests/fixtures/inventory/derivation.json) so both sides cannot drift apart.

from datetime import timedelta

OVERDUE_AFTER = timedelta(days=10)


def to_buy(mode, needed, level, quantity, min_quantity, restock_to, on_order, has_open_order):
    """Return the quantity to buy, or 0 when the item is not on the to-buy list.

    `on_order` is the summed quantity of open orders; `has_open_order` whether any is open. Every mode
    but `units` leaves the list while an order is open; `units` stays for the part no order covers."""
    # Pinned is on_demand plus "shown first in the inventory" (owner, 2026-11-25, APLANE-77): never always on the list.
    if mode in ("on_demand", "pinned"):
        return 1 if needed and not has_open_order else 0
    if mode == "level":
        return 1 if level in ("low", "out") and not has_open_order else 0
    if mode == "units":
        have = max(quantity or 0, 0)
        minimum = min_quantity or 0
        if have + on_order >= minimum:
            return 0
        target = restock_to if restock_to is not None else minimum
        return max(1, target - have - on_order)
    return 0
