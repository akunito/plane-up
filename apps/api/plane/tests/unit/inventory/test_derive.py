# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The to-buy rule against the shared fixture the TypeScript package reads too (plan, phase 3)."""

import json
from pathlib import Path

import pytest

from plane.app.inventory.derive import counts, to_buy

pytestmark = pytest.mark.unit

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "inventory" / "derivation.json"
CASES = json.loads(FIXTURE.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_to_buy(case):
    got = to_buy(
        case["mode"],
        case.get("needed", False),
        case.get("level"),
        case.get("quantity"),
        case.get("min_quantity"),
        case.get("restock_to"),
        case["on_order"],
        case["has_open_order"],
    )
    assert got == case["to_buy"]


def test_pinned_rows_never_count():
    assert not counts("pinned") and all(counts(m) for m in ("on_demand", "level", "units"))
