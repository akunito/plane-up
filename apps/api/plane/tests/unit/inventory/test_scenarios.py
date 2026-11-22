# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The server-side scenarios of the plan's catalogue, each issuing the calls in the stated order.
"Offline" means the operation is built against the revision the device last saw and delivered later.
Client-side scenarios (queue, "Done", holds) belong to the shared package and the app (phases 3, 6)."""

import uuid

import pytest

from plane.app.inventory import engine
from plane.app.inventory.derive import to_buy
from plane.db.models import InventoryItem, InventoryList, InventoryOrder, Project, ProjectMember

from .conftest import fresh, op

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


def go(ctx, user, raw):
    return engine.apply_operation(raw, ctx(user))


def listed(item, on_order=0, has_open=False):
    item = fresh(item)
    return to_buy(
        item.mode, item.needed, item.level, item.quantity, item.min_quantity, item.restock_to, on_order, has_open
    )


def test_S02_a_late_purchase_wins_over_a_later_statement(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="low")
    bought_offline = op("buy", item)
    go(ctx, bob, op("set_level", item, {"level": "out"}, base_rev=0))
    assert go(ctx, alice, bought_offline)["result"] == "applied"
    assert fresh(item).level == "ok"


def test_S03_a_statement_after_someone_elses_purchase_is_refused_and_says_why(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="low")
    out_offline = op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4())
    go(ctx, bob, op("buy", item))
    out = go(ctx, alice, out_offline)
    assert out["result"] == "stale" and out["changed"]["op"] == "buy" and fresh(item).level == "ok"


def test_S04_an_older_statement_does_not_overwrite_a_newer_one(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="out")
    ok_offline = op("set_level", item, {"level": "ok"}, base_rev=0, queue=uuid.uuid4())
    go(ctx, bob, op("set_level", item, {"level": "low"}, base_rev=0))
    assert go(ctx, alice, ok_offline)["result"] == "stale" and fresh(item).level == "low"


@pytest.mark.parametrize("bob_first", [True, False])
def test_S05_deltas_in_either_arrival_order(bob_first, make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=1)
    alice_ops = [op("adjust", item, {"delta": -1}), op("adjust", item, {"delta": -1})]
    bob_op = op("adjust", item, {"delta": 2})
    order = (
        [(bob, bob_op)] + [(alice, o) for o in alice_ops]
        if bob_first
        else [(alice, o) for o in alice_ops] + [(bob, bob_op)]
    )
    for user, raw in order:
        go(ctx, user, raw)
    assert fresh(item).quantity == 1


def test_S06_an_untick_after_someone_else_changed_the_item_is_refused(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="low")
    tick = go(ctx, alice, op("buy", item))
    go(ctx, bob, op("set_level", item, {"level": "out"}, base_rev=fresh(item).state_rev))
    for _ in range(2):  # stale screen, then refreshed: the revert compares against the item, not the screen
        out = go(ctx, alice, op("revert", item, {"reverts": tick["client_op_id"]}))
        assert (out["result"], out["reason"]) == ("rejected", "changed_since")


def test_S07_tick_and_untick_a_units_item(make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=1, min_quantity=3)
    tick = go(ctx, alice, op("buy", item, {"quantity": 2}))
    go(ctx, alice, op("revert", item, {"reverts": tick["client_op_id"]}))
    assert fresh(item).quantity == 1
    tick = go(ctx, alice, op("buy", item, {"quantity": 2}))
    go(ctx, bob, op("adjust", item, {"delta": -1}))
    assert go(ctx, alice, op("revert", item, {"reverts": tick["client_op_id"]}))["reason"] == "changed_since"
    assert fresh(item).quantity == 2


def test_S10_pinned_then_unpinned_is_not_needed(make_item, ctx, alice):
    item = make_item(mode="on_demand", needed=True)
    go(ctx, alice, op("pin", item, {"pinned": True}, base_rev=0))
    go(ctx, alice, op("pin", item, {"pinned": False}, base_rev=1))
    item = fresh(item)
    assert (item.mode, item.needed) == ("on_demand", False)


def test_S11_switching_back_to_units_needs_a_new_quantity(make_item, ctx, alice):
    item = make_item(mode="units", quantity=7, min_quantity=2)
    go(ctx, alice, op("change_mode", item, {"mode": "level"}, base_rev=0))
    assert go(ctx, alice, op("change_mode", item, {"mode": "units"}, base_rev=1))["reason"] == "invalid"
    go(ctx, alice, op("change_mode", item, {"mode": "units", "quantity": 1}, base_rev=1))
    assert fresh(item).quantity == 1, "no old number returns"


def test_S12_units_with_an_order_partly_covering(make_item, ctx, alice):
    item = make_item(mode="units", quantity=1, min_quantity=3, restock_to=3)
    order_id = str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": order_id, "quantity": 2}))
    assert listed(item, on_order=2, has_open=True) == 0
    go(ctx, alice, op("adjust", item, {"delta": -1}))
    assert listed(item, on_order=2, has_open=True) == 1
    go(ctx, alice, op("arrived", item, {"order_id": order_id}))
    assert fresh(item).quantity == 2 and listed(item) == 1


def test_S13_cancelling(make_item, ctx, alice):
    item = make_item(mode="on_demand", needed=True)
    open_id, received_id = str(uuid.uuid4()), str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": open_id}))
    assert go(ctx, alice, op("cancel", item, {"order_id": open_id}))["result"] == "applied"
    assert listed(item) == 1, "back on the list while still needed"
    go(ctx, alice, op("mark_ordered", item, {"order_id": received_id}))
    go(ctx, alice, op("arrived", item, {"order_id": received_id}))
    assert go(ctx, alice, op("cancel", item, {"order_id": received_id}))["reason"] == "already_done"


def test_S14_part_of_an_order_now_the_rest_later_with_plus(make_item, ctx, alice):
    item = make_item(mode="units", quantity=0, min_quantity=2)
    order_id = str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": order_id, "quantity": 2}))
    go(ctx, alice, op("arrived", item, {"order_id": order_id, "quantity": 1}))
    assert InventoryOrder.objects.get(pk=order_id).status == "received"
    go(ctx, alice, op("adjust", item, {"delta": 1}))
    assert fresh(item).quantity == 2


def test_S17_a_bought_pinned_item_stays_listed_with_who_and_when(make_item, ctx, alice):
    item = make_item(mode="pinned")
    go(ctx, alice, op("buy", item))
    item = fresh(item)
    assert listed(item) == 1 and item.last_bought_by_id == alice.id and item.last_bought_at is not None


def test_S37_two_offline_taps_from_one_queue_both_apply_in_order(make_item, ctx, alice):
    item = make_item(mode="level", level="ok")
    queue = uuid.uuid4()
    first = op("set_level", item, {"level": "low"}, base_rev=0, queue=queue)
    second = op("set_level", item, {"level": "out"}, base_rev=0, queue=queue)
    assert [go(ctx, alice, r)["result"] for r in (first, second)] == ["applied", "applied"]
    assert fresh(item).level == "out"


def test_S38_a_change_between_two_offline_taps_refuses_both(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="ok")
    queue = uuid.uuid4()
    first = op("set_level", item, {"level": "low"}, base_rev=0, queue=queue)
    second = op("set_level", item, {"level": "out"}, base_rev=0, queue=queue)
    go(ctx, bob, op("set_level", item, {"level": "ok"}, base_rev=0))
    assert [go(ctx, alice, r)["result"] for r in (first, second)] == ["stale", "stale"]


@pytest.mark.parametrize(
    "mode,check",
    [
        ("level", lambda i: i.level == "ok"),
        ("on_demand", lambda i: i.needed is False),
        ("pinned", lambda i: i.last_bought_at is not None),
        ("units", lambda i: i.quantity == 2),
    ],
)
def test_S43_arrival_in_each_mode_and_a_second_arrival(mode, check, make_item, ctx, alice):
    item = make_item(mode=mode)
    order_id = str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": order_id, "quantity": 2}))
    go(ctx, alice, op("arrived", item, {"order_id": order_id}))
    assert check(fresh(item))
    assert go(ctx, alice, op("arrived", item, {"order_id": order_id}))["reason"] == "already_done"


def test_S44_arrival_of_a_cancelled_order(make_item, ctx, alice):
    item = make_item(mode="units", quantity=0)
    order_id = str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": order_id, "quantity": 3}))
    go(ctx, alice, op("cancel", item, {"order_id": order_id}))
    go(ctx, alice, op("arrived", item, {"order_id": order_id}))
    assert fresh(item).quantity == 3 and InventoryOrder.objects.get(pk=order_id).status == "received"


def test_S45_recount_fresh_stale_and_with_a_purchase_in_transit(make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=1)
    assert go(ctx, alice, op("recount", item, {"quantity": 4}, base_rev=0))["result"] == "applied"
    go(ctx, bob, op("adjust", item, {"delta": -1}))
    assert go(ctx, alice, op("recount", item, {"quantity": 9}, base_rev=1, queue=uuid.uuid4()))["result"] == "stale"
    in_bobs_bag = op("buy", item, {"quantity": 2})
    go(ctx, alice, op("recount", item, {"quantity": 5}, base_rev=fresh(item).state_rev))
    go(ctx, bob, in_bobs_bag)
    assert fresh(item).quantity == 7, "accepted behaviour 3: the purchase is added when it arrives"


def test_S46_a_queued_purchase_survives_a_mode_change_and_a_move(make_item, ctx, alice, bob, groceries, workspace):
    item = make_item(mode="on_demand")
    queued = op("buy", item, {"quantity": 1})
    go(ctx, bob, op("change_mode", item, {"mode": "units", "quantity": 0}, base_rev=0))
    assert go(ctx, alice, queued)["result"] == "applied"
    assert fresh(item).quantity == 1, "one added: the purchase applies in the mode it finds"
    # Moved to another list of the same project: still applies.
    pantry = InventoryList.objects.create(name="Pantry", project=groceries.project)
    InventoryItem.objects.filter(pk=item.pk).update(inventory_list=pantry)
    assert go(ctx, alice, op("buy", item))["result"] == "applied"
    # Moved to a project the buyer is not in: refused and shown.
    hers = Project.objects.create(name="Hers", identifier="HERS", workspace=workspace, inventory_view=True)
    ProjectMember.objects.create(project=hers, member=bob, role=15)
    InventoryItem.objects.filter(pk=item.pk).update(
        project=hers, inventory_list=InventoryList.objects.create(name="Hers", project=hers)
    )
    assert go(ctx, alice, op("buy", item))["reason"] == "forbidden"


def test_S54_needed_flagged_while_on_order_is_cleared_by_the_arrival(make_item, ctx, alice, bob):
    item = make_item(mode="on_demand", needed=False)
    order_id = str(uuid.uuid4())
    go(ctx, alice, op("mark_ordered", item, {"order_id": order_id}))
    go(ctx, bob, op("set_needed", item, {"needed": True}, base_rev=1))
    go(ctx, alice, op("arrived", item, {"order_id": order_id}))
    assert fresh(item).needed is False


def test_S58_editing_an_items_data_does_not_refuse_a_queued_statement(make_item, ctx, alice, bob):
    item = make_item(mode="level", level="ok")
    queued = op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4())
    item.name = "Rice (basmati)"
    item.save()
    assert go(ctx, alice, queued)["result"] == "applied"


def test_S63_a_late_minus_one_after_a_recount_leaves_the_total_low(make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=3, min_quantity=2)
    minus_offline = op("adjust", item, {"delta": -1})
    go(ctx, bob, op("recount", item, {"quantity": 2}, base_rev=0))
    go(ctx, alice, minus_offline)
    assert fresh(item).quantity == 1 and listed(item) == 1, "accepted behaviour 3"


def test_S65_undo_after_a_lost_answer_reverts_on_the_server(make_item, ctx, alice):
    item = make_item(mode="on_demand", needed=True)
    tick = op("buy", item)
    go(ctx, alice, tick)  # applied; the answer never reached the phone
    out = go(ctx, alice, op("revert", item, {"reverts": tick["client_op_id"]}))
    assert out["result"] == "applied" and fresh(item).needed is True
    assert go(ctx, alice, tick)["duplicate"] is True, "the retry of the tick does not apply it again"
    assert fresh(item).needed is True


@pytest.mark.parametrize("surface", ["widget", "mcp", "shared_phone"])
def test_S67_queueless_surfaces_and_shared_phones_are_never_exempt(surface, make_item, ctx, alice, bob):
    item = make_item(mode="level", level="ok")
    if surface == "shared_phone":
        phone = uuid.uuid4()
        go(ctx, bob, op("set_level", item, {"level": "low"}, base_rev=0, queue=phone))
        late = op("set_level", item, {"level": "out"}, base_rev=0, queue=phone)
        assert go(ctx, alice, late)["result"] == "stale"
        return
    source = "api" if surface == "mcp" else "web"
    go(ctx, bob, op("set_level", item, {"level": "low"}, base_rev=0, queue=uuid.uuid4()))
    late = op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4())
    assert engine.apply_operation(late, ctx(alice, source=source))["result"] == "stale"
