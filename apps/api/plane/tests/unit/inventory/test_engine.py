# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The operations engine (APLANE-60; brief: Item state, Orders, Operations and concurrency)."""

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from plane.app.inventory import engine
from plane.db.models import InventoryEvent, InventoryOrder, Project, ProjectMember, Workspace

from .conftest import fresh, op

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

MODES = ("pinned", "on_demand", "level", "units")


def apply(ctx, raw):
    return engine.apply_operation(raw, ctx)


# ---------------------------------------------------------------- every operation x every mode

# (op, args, needs base_rev) -> {mode: expected result or reason}
TABLE = [
    ("adjust", {"delta": 2}, False, {"units": "applied"}),
    ("buy", {}, False, {m: "applied" for m in MODES}),
    ("mark_ordered", None, False, {m: "applied" for m in MODES}),
    ("set_level", {"level": "out"}, True, {"level": "applied"}),
    ("set_needed", {"needed": False}, True, {"on_demand": "applied"}),
    ("pin", {"pinned": True}, True, {"on_demand": "applied", "pinned": "applied"}),
    ("recount", {"quantity": 5}, True, {"units": "applied"}),
]


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name,args,cas,expected", TABLE, ids=[row[0] for row in TABLE])
def test_every_operation_in_every_mode(name, args, cas, expected, mode, make_item, ctx, alice):
    item = make_item(mode=mode)
    if name == "mark_ordered":
        args = {"order_id": str(uuid.uuid4())}
    out = apply(ctx(alice), op(name, item, args, base_rev=item.state_rev if cas else None))
    want = expected.get(mode, "invalid_for_mode")
    if want == "applied":
        assert out["result"] == "applied", out
        assert fresh(item).state_rev == 1
    else:
        assert (out["result"], out.get("reason")) == ("rejected", want), out
        assert fresh(item).state_rev == 0, "a refused operation never advances the revision"


@pytest.mark.parametrize(
    "mode,check",
    [
        ("pinned", lambda i: i.last_bought_at is not None),
        ("on_demand", lambda i: i.needed is False and i.needed_by_id is None),
        ("level", lambda i: i.level == "ok"),
        ("units", lambda i: i.quantity == 3),
    ],
)
def test_buy_takes_effect_according_to_the_mode(mode, check, make_item, ctx, alice):
    item = make_item(mode=mode)
    out = apply(ctx(alice), op("buy", item, {"quantity": 3}))
    assert out["result"] == "applied"
    item = fresh(item)
    assert check(item) and item.last_bought_by_id == alice.id


def test_quantity_is_never_clamped(make_item, ctx, alice):
    item = make_item(mode="units", quantity=1)
    apply(ctx(alice), op("adjust", item, {"delta": -4}))
    assert fresh(item).quantity == -3


@pytest.mark.parametrize(
    "target_mode,args,expect",
    [
        ("units", {"mode": "units", "quantity": 4}, {"quantity": 4, "min_quantity": 1, "needed": False}),
        ("level", {"mode": "level"}, {"level": "ok", "quantity": None}),
        ("pinned", {"mode": "pinned"}, {"needed": False, "level": None}),
    ],
)
def test_change_mode_clears_what_the_new_mode_does_not_use(target_mode, args, expect, make_item, ctx, alice):
    item = make_item(mode="on_demand")
    out = apply(ctx(alice), op("change_mode", item, args, base_rev=0))
    assert out["result"] == "applied", out
    item = fresh(item)
    assert item.mode == target_mode
    for field, value in expect.items():
        assert getattr(item, field) == value, field


def test_change_mode_keeps_the_thresholds_and_sets_an_empty_minimum_to_one(make_item, ctx, alice):
    item = make_item(mode="units", quantity=2, min_quantity=3, restock_to=6)
    apply(ctx(alice), op("change_mode", item, {"mode": "level"}, base_rev=0))
    item = fresh(item)
    assert (item.min_quantity, item.restock_to, item.quantity) == (3, 6, None)
    other = make_item(name="Bread", mode="pinned")
    apply(ctx(alice), op("change_mode", other, {"mode": "units", "quantity": 0}, base_rev=0))
    assert fresh(other).min_quantity == 1


def test_change_mode_to_units_needs_the_typed_quantity(make_item, ctx, alice):
    item = make_item(mode="level")
    out = apply(ctx(alice), op("change_mode", item, {"mode": "units"}, base_rev=0))
    assert (out["result"], out["reason"]) == ("rejected", "invalid")


def test_unpinning_gives_on_demand_not_needed(make_item, ctx, alice):
    item = make_item(mode="pinned")
    apply(ctx(alice), op("pin", item, {"pinned": False}, base_rev=0))
    item = fresh(item)
    assert (item.mode, item.needed) == ("on_demand", False)


# ---------------------------------------------------------------- compare-and-set


def test_a_statement_on_the_current_revision_applies(make_item, ctx, alice):
    item = make_item(mode="level")
    assert apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0))["result"] == "applied"


def test_a_statement_after_someone_elses_change_is_stale_and_says_who(make_item, ctx, alice, bob):
    item = make_item(mode="level")
    apply(ctx(bob), op("set_level", item, {"level": "ok"}, base_rev=0, queue=uuid.uuid4()))
    out = apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4()))
    assert out["result"] == "stale"
    assert out["changed"]["by"] == str(bob.id) and out["item"]["level"] == "ok"
    assert fresh(item).level == "ok"


def test_the_second_of_two_taps_from_the_same_queue_applies(make_item, ctx, alice):
    item = make_item(mode="level")
    queue = uuid.uuid4()
    apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0, queue=queue))
    out = apply(ctx(alice), op("set_level", item, {"level": "ok"}, base_rev=0, queue=queue))
    assert out["result"] == "applied"


@pytest.mark.parametrize("second_queue", ["other", "none"])
def test_the_exemption_needs_the_same_person_and_the_same_queue(second_queue, make_item, ctx, alice):
    item = make_item(mode="level")
    apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4()))
    queue = uuid.uuid4() if second_queue == "other" else None
    out = apply(ctx(alice), op("set_level", item, {"level": "ok"}, base_rev=0, queue=queue))
    assert out["result"] == "stale", "same person from elsewhere, or a queueless surface, is not exempt"


def test_two_queueless_statements_from_the_same_person_are_not_exempt(make_item, ctx, alice):
    """A request with no queue id (widget, project page, MCP) never counts as "the same queue", not even
    against another queueless request: null is not an identity."""
    item = make_item(mode="level")
    apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0))
    assert apply(ctx(alice), op("set_level", item, {"level": "ok"}, base_rev=0))["result"] == "stale"


def test_a_shared_queue_id_does_not_exempt_another_person(make_item, ctx, alice, bob):
    item = make_item(mode="level")
    queue = uuid.uuid4()
    apply(ctx(bob), op("set_level", item, {"level": "out"}, base_rev=0, queue=queue))
    assert apply(ctx(alice), op("set_level", item, {"level": "ok"}, base_rev=0, queue=queue))["result"] == "stale"


def test_a_purchase_from_anyone_counts_as_a_change_for_a_later_statement(make_item, ctx, alice, bob):
    item = make_item(mode="level")
    apply(ctx(bob), op("buy", item))
    assert (
        apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4()))["result"] == "stale"
    )


def test_a_missing_ledger_step_counts_as_someone_elses_change(make_item, ctx, alice):
    """Proven, not inferred from absence: a pruned step cannot be shown to be ours."""
    item = make_item(mode="level")
    queue = uuid.uuid4()
    first = apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0, queue=queue))
    InventoryEvent.objects.filter(client_op_id=first["client_op_id"]).delete()
    assert apply(ctx(alice), op("set_level", item, {"level": "ok"}, base_rev=0, queue=queue))["result"] == "stale"


def test_a_base_rev_from_the_future_is_stale(make_item, ctx, alice):
    item = make_item(mode="level")
    assert apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=7))["result"] == "stale"


def test_a_statement_without_base_rev_is_invalid(make_item, ctx, alice):
    item = make_item(mode="level")
    raw = op("set_level", item, {"level": "out"})
    assert (apply(ctx(alice), raw)["result"], apply(ctx(alice), op("set_level", item, {"level": "out"}))["reason"]) == (
        "rejected",
        "invalid",
    )


def test_things_that_happened_ignore_base_rev(make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=1)
    apply(ctx(bob), op("adjust", item, {"delta": 1}))
    assert apply(ctx(alice), op("adjust", item, {"delta": 1}, base_rev=0))["result"] == "applied"
    assert fresh(item).quantity == 3


# ---------------------------------------------------------------- revert


def test_reverting_an_adjust_applies_the_opposite_amount(make_item, ctx, alice):
    item = make_item(mode="units", quantity=2)
    first = apply(ctx(alice), op("adjust", item, {"delta": -1}))
    out = apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    assert out["result"] == "applied" and fresh(item).quantity == 2


def test_reverting_a_units_purchase_subtracts_it(make_item, ctx, alice):
    item = make_item(mode="units", quantity=0)
    first = apply(ctx(alice), op("buy", item, {"quantity": 4}))
    apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    item = fresh(item)
    assert item.quantity == 0 and item.last_bought_at is None


def test_reverting_a_purchase_restores_needed_and_the_last_bought_time(make_item, ctx, alice, bob):
    item = make_item(mode="on_demand", needed=True, needed_by=bob)
    apply(ctx(alice), op("buy", item))
    old = fresh(item).last_bought_at
    second = apply(ctx(alice), op("buy", item))
    apply(ctx(alice), op("revert", item, {"reverts": second["client_op_id"]}))
    item = fresh(item)
    assert item.last_bought_at == old
    first_needed = make_item(name="Eggs", mode="on_demand", needed=True, needed_by=bob)
    bought = apply(ctx(alice), op("buy", first_needed))
    apply(ctx(alice), op("revert", first_needed, {"reverts": bought["client_op_id"]}))
    first_needed = fresh(first_needed)
    assert first_needed.needed is True and first_needed.needed_by_id == bob.id


def test_reverting_a_statement_restores_what_was_there(make_item, ctx, alice):
    item = make_item(mode="level", level="low")
    first = apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0))
    apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    assert fresh(item).level == "low"


def test_reverting_a_mode_change_restores_the_old_mode_and_state(make_item, ctx, alice):
    item = make_item(mode="on_demand", needed=True)
    first = apply(ctx(alice), op("change_mode", item, {"mode": "units", "quantity": 3}, base_rev=0))
    apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    item = fresh(item)
    # The minimum the switch filled in stays: it is data, and only matters in units mode (brief).
    assert (item.mode, item.needed, item.quantity, item.min_quantity) == ("on_demand", True, None, 1)


def test_a_revert_after_any_later_change_is_refused_not_stale(make_item, ctx, alice, bob):
    """Refused rather than stale: "apply anyway" exists only for stale, and a revert never could."""
    item = make_item(mode="units", quantity=0)
    first = apply(ctx(alice), op("adjust", item, {"delta": 1}))
    apply(ctx(bob), op("adjust", item, {"delta": 1}))
    out = apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    assert (out["result"], out["reason"]) == ("rejected", "changed_since") and fresh(item).quantity == 2


def test_a_revert_restores_state_but_never_the_minimum(make_item, ctx, home, alice, bob):
    """min_quantity is data: a data edit between the statement and its undo must survive the undo, and
    the restock rule must not break (phase 2 audit: it used to raise and fail the whole batch)."""
    item = make_item(mode="units", quantity=0, min_quantity=None)
    first = apply(ctx(alice), op("recount", item, {"quantity": 2}, base_rev=0))
    type(item).objects.filter(pk=item.pk).update(min_quantity=2, restock_to=3)
    out = apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    item = fresh(item)
    assert out["result"] == "applied" and (item.quantity, item.min_quantity, item.restock_to) == (0, 2, 3)


@pytest.mark.parametrize(
    "case,reason",
    [("twice", "already_done"), ("order_action", "not_revertible"), ("someone_else", "not_yours"), ("unknown", "gone")],
)
def test_reverts_that_cannot_apply(case, reason, make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=0)
    if case == "order_action":
        target = apply(ctx(alice), op("mark_ordered", item, {"order_id": str(uuid.uuid4())}))["client_op_id"]
    elif case == "unknown":
        target = str(uuid.uuid4())
    else:
        target = apply(ctx(alice), op("adjust", item, {"delta": 1}))["client_op_id"]
    if case == "twice":
        apply(ctx(alice), op("revert", item, {"reverts": target}))
    actor = bob if case == "someone_else" else alice
    out = apply(ctx(actor), op("revert", item, {"reverts": target}))
    assert (out["result"], out.get("reason")) == ("rejected", reason), out


def test_a_stale_statement_cannot_be_reverted(make_item, ctx, alice, bob):
    item = make_item(mode="level")
    apply(ctx(bob), op("set_level", item, {"level": "ok"}, base_rev=0))
    stale = apply(ctx(alice), op("set_level", item, {"level": "out"}, base_rev=0))
    out = apply(ctx(alice), op("revert", item, {"reverts": stale["client_op_id"]}))
    assert out["reason"] == "not_revertible"


# ---------------------------------------------------------------- duplicates


@pytest.mark.parametrize("kind", ["applied", "stale", "rejected"])
def test_a_duplicate_returns_the_recorded_result_and_changes_nothing(kind, make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=0)
    if kind == "applied":
        raw = op("adjust", item, {"delta": 1})
    elif kind == "stale":
        apply(ctx(bob), op("recount", item, {"quantity": 5}, base_rev=0))
        raw = op("recount", item, {"quantity": 9}, base_rev=0)
    else:
        raw = op("set_level", item, {"level": "out"}, base_rev=0)
    first = apply(ctx(alice), raw)
    rev = fresh(item).state_rev
    again = apply(ctx(alice), raw)
    assert again["duplicate"] is True and again["result"] == first["result"] == kind
    assert fresh(item).state_rev == rev
    assert InventoryEvent.objects.filter(client_op_id=raw["client_op_id"]).count() == 1


def test_a_duplicate_is_answered_only_after_the_authorisation_check(make_item, ctx, home, bob):
    item = make_item(mode="units")
    raw = op("adjust", item, {"delta": 1})
    assert apply(ctx(bob), raw)["result"] == "applied"
    ProjectMember.objects.filter(project=home, member=bob).update(is_active=False)
    out = apply(ctx(bob), raw)
    assert (out["result"], out.get("reason"), out.get("duplicate")) == ("rejected", "forbidden", None)


def test_someone_elses_client_op_id_is_refused(make_item, ctx, alice, bob):
    item = make_item(mode="units")
    raw = op("adjust", item, {"delta": 1})
    apply(ctx(alice), raw)
    assert apply(ctx(bob), raw)["reason"] == "duplicate_id"
    assert fresh(item).quantity == 1


# ---------------------------------------------------------------- orders


def test_an_order_takes_the_device_id_and_cannot_be_placed_twice(make_item, ctx, alice):
    item = make_item(mode="on_demand")
    order_id = uuid.uuid4()
    out = apply(ctx(alice, source="api"), op("mark_ordered", item, {"order_id": str(order_id), "quantity": 2}))
    assert out["result"] == "applied" and out["order_id"] == str(order_id)
    order = InventoryOrder.objects.get(pk=order_id)
    assert (order.quantity, order.status, order.source) == (2, "open", "api")
    again = apply(ctx(alice), op("mark_ordered", item, {"order_id": str(order_id)}))
    assert again["reason"] == "already_done"


def test_order_transitions(make_item, ctx, alice):
    item = make_item(mode="units", quantity=0, min_quantity=2)
    a, b = uuid.uuid4(), uuid.uuid4()
    for order_id in (a, b):
        apply(ctx(alice), op("mark_ordered", item, {"order_id": str(order_id), "quantity": 2}))
    assert apply(ctx(alice), op("cancel", item, {"order_id": str(b)}))["result"] == "applied"
    assert apply(ctx(alice), op("cancel", item, {"order_id": str(b)}))["reason"] == "already_done"
    # cancelled -> received: the parcel came anyway
    assert apply(ctx(alice), op("arrived", item, {"order_id": str(b)}))["result"] == "applied"
    assert apply(ctx(alice), op("arrived", item, {"order_id": str(b)}))["reason"] == "already_done"
    assert apply(ctx(alice), op("cancel", item, {"order_id": str(b)}))["reason"] == "already_done"
    # a smaller quantity than ordered closes the order with what came
    apply(ctx(alice), op("arrived", item, {"order_id": str(a), "quantity": 1}))
    order = InventoryOrder.objects.get(pk=a)
    assert (order.status, order.received_quantity) == ("received", 1)
    assert fresh(item).quantity == 3


def test_an_order_of_another_item_is_gone(make_item, ctx, alice):
    milk, bread = make_item(), make_item(name="Bread")
    order_id = uuid.uuid4()
    apply(ctx(alice), op("mark_ordered", milk, {"order_id": str(order_id)}))
    assert apply(ctx(alice), op("arrived", bread, {"order_id": str(order_id)}))["reason"] == "gone"


def test_order_actions_advance_the_revision(make_item, ctx, alice):
    item = make_item()
    order_id = str(uuid.uuid4())
    apply(ctx(alice), op("mark_ordered", item, {"order_id": order_id}))
    apply(ctx(alice), op("cancel", item, {"order_id": order_id}))
    assert fresh(item).state_rev == 2


def test_a_purchase_while_an_order_is_open_stamps_it_once(make_item, ctx, alice, bob):
    """S64: A buys in a store offline, B orders online meanwhile, A syncs."""
    item = make_item(mode="on_demand")
    order_id = uuid.uuid4()
    apply(ctx(bob), op("mark_ordered", item, {"order_id": str(order_id)}))
    first = apply(ctx(alice), op("buy", item, age_ms=3_600_000))  # bought an hour ago, before the order
    order = InventoryOrder.objects.get(pk=order_id)
    assert order.status == "open" and order.bought_since_by_id == alice.id and order.bought_since_at is not None
    stamp = order.bought_since_at
    apply(ctx(bob), op("buy", item))
    assert InventoryOrder.objects.get(pk=order_id).bought_since_at == stamp, "the first purchase keeps the stamp"
    # Reverting the purchase that set a stamp needs nothing to have changed since; bob's buy did.
    assert apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))["reason"] == "changed_since"


def test_an_arrival_does_not_stamp_the_items_other_open_orders(make_item, ctx, alice):
    """S15: two deliberate orders; the first arriving is not "bought since" for the second."""
    item = make_item(mode="units", quantity=0, min_quantity=4)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    for order_id in (a, b):
        apply(ctx(alice), op("mark_ordered", item, {"order_id": order_id, "quantity": 2}))
    apply(ctx(alice), op("arrived", item, {"order_id": a}))
    assert InventoryOrder.objects.get(pk=b).bought_since_at is None


@pytest.mark.parametrize(
    "name,args,cas",
    [
        ("recount", {"quantity": 99_999_999_999}, True),
        ("adjust", {"delta": -(10**12)}, False),
        ("mark_ordered", {"order_id": "ORDER", "quantity": 10**10}, False),
    ],
)
def test_out_of_range_input_is_invalid_for_that_operation_only(name, args, cas, make_item, ctx, alice):
    """Refused by the bound, so recorded in the ledger like any other refusal; a database error caught
    later would not be (that is what tells the two paths apart)."""
    item = make_item(mode="units", quantity=0)
    args = {k: (str(uuid.uuid4()) if v == "ORDER" else v) for k, v in args.items()}
    first = op(name, item, args, base_rev=0 if cas else None)
    results = engine.apply_batch([first, op("adjust", item, {"delta": 1})], ctx(alice))
    assert [(r["result"], r.get("reason")) for r in results] == [("rejected", "invalid"), ("applied", None)]
    assert InventoryEvent.objects.get(client_op_id=first["client_op_id"]).reason == "invalid"
    assert fresh(item).quantity == 1


def test_nul_in_the_arguments_of_a_refused_operation_does_not_fail_the_batch(make_item, ctx, alice):
    """jsonb refuses NUL and the ledger row is written on refusal paths too (phase 2 re-review)."""
    item = make_item(mode="units", quantity=0)
    bad = op("set_level", item, {"level": "out", "note": "a\x00b"}, base_rev=0)
    results = engine.apply_batch([bad, op("adjust", item, {"delta": 1})], ctx(alice))
    assert [(r["result"], r.get("reason")) for r in results] == [("rejected", "invalid"), ("applied", None)]


def test_a_transient_database_error_propagates_so_the_device_retries(make_item, ctx, alice, monkeypatch):
    """A deadlock or timeout answered "rejected" would make the device drop a purchase for good."""
    from django.db import OperationalError

    def deadlock(*args, **kwargs):
        raise OperationalError("deadlock detected")

    monkeypatch.setitem(engine.HANDLERS, "adjust", deadlock)
    item = make_item(mode="units", quantity=0)
    with pytest.raises(OperationalError):
        apply(ctx(alice), op("adjust", item, {"delta": 1}))


def test_a_stale_duplicate_that_loses_the_race_is_answered_from_the_ledger(make_item, ctx, alice, bob, monkeypatch):
    """Deterministic version of the race in test_overlap: the twin's ledger row is committed, but this
    copy's duplicate check ran just before that commit and did not see it."""
    item = make_item(mode="level")
    apply(ctx(bob), op("set_level", item, {"level": "ok"}, base_rev=0))
    raw = op("set_level", item, {"level": "out"}, base_rev=0)
    engine.InventoryEvent.objects.create(
        client_op_id=raw["client_op_id"],
        workspace_id=item.workspace_id,
        item=item,
        actor=alice,
        op="set_level",
        result="stale",
        occurred_at=timezone.now(),
    )
    monkeypatch.setattr(engine, "_ledger_row", lambda client_op_id: None)
    out = apply(ctx(alice), raw)
    assert (out["result"], out.get("duplicate")) == ("stale", True)


def test_the_engine_locks_only_the_item_row():
    import inspect

    assert 'select_for_update(of=("self",))' in inspect.getsource(engine.apply_operation)


def test_an_absurd_age_is_clamped_not_an_overflow(make_item, ctx, alice):
    item = make_item(mode="pinned")
    assert apply(ctx(alice), op("buy", item, age_ms=10**20))["result"] == "applied"


def test_a_workspace_guest_with_a_member_role_in_the_project_is_still_refused(make_item, ctx, home, gus):
    ProjectMember.objects.filter(project=home, member=gus).update(role=15)
    item = make_item(mode="units")
    assert apply(ctx(gus), op("adjust", item, {"delta": 1}))["reason"] == "forbidden"


def test_reverting_the_purchase_that_stamped_an_order_clears_the_stamp(make_item, ctx, alice, bob):
    item = make_item(mode="on_demand")
    order_id = uuid.uuid4()
    apply(ctx(bob), op("mark_ordered", item, {"order_id": str(order_id)}))
    first = apply(ctx(alice), op("buy", item))
    apply(ctx(alice), op("revert", item, {"reverts": first["client_op_id"]}))
    assert InventoryOrder.objects.get(pk=order_id).bought_since_at is None


# ---------------------------------------------------------------- authorisation


@pytest.mark.parametrize(
    "who,setup,expected",
    [
        ("alice", None, "applied"),
        ("bob", None, "applied"),
        ("gus", None, "forbidden"),
        ("olga", None, "forbidden"),
        ("bob", "deactivated", "forbidden"),
        ("bob", "left_workspace", "forbidden"),
        ("bob", "archived", "forbidden"),
        ("bob", "flag_off", "forbidden"),
        ("bob", "project_deleted", "gone"),
        ("bob", "list_deleted", "gone"),
        ("bob", "item_deleted", "gone"),
    ],
)
def test_authorisation_against_the_items_current_project(
    who, setup, expected, request, make_item, ctx, home, workspace
):
    user = request.getfixturevalue(who)
    item = make_item(mode="units")
    now = timezone.now()
    if setup == "deactivated":
        ProjectMember.objects.filter(project=home, member=user).update(is_active=False)
    elif setup == "left_workspace":
        workspace.workspace_member.filter(member=user).update(is_active=False)
    elif setup == "archived":
        Project.objects.filter(pk=home.pk).update(archived_at=now)
    elif setup == "flag_off":
        Project.objects.filter(pk=home.pk).update(inventory_view=False)
    elif setup == "project_deleted":
        Project.all_objects.filter(pk=home.pk).update(deleted_at=now)
    elif setup == "list_deleted":
        type(item.inventory_list).all_objects.filter(pk=item.inventory_list_id).update(deleted_at=now)
    elif setup == "item_deleted":
        type(item).all_objects.filter(pk=item.pk).update(deleted_at=now)
    out = apply(ctx(user), op("adjust", item, {"delta": 1}))
    assert out["result"] == expected if expected == "applied" else out.get("reason") == expected, out
    assert fresh(item).quantity == (1 if expected == "applied" else 0)


def test_an_item_of_another_workspace_is_gone(make_item, ctx, alice):
    item = make_item(mode="units")
    other = Workspace.objects.create(name="Other", slug="other-ws", owner=alice)
    out = engine.apply_operation(
        op("adjust", item, {"delta": 1}),
        engine.Context(user=alice, workspace_id=other.pk, source="web", now=timezone.now()),
    )
    assert out["reason"] == "gone" and fresh(item).quantity == 0


# ---------------------------------------------------------------- versions, input, batches, time


def test_an_unknown_format_version_is_rejected_not_recorded(make_item, ctx, alice):
    item = make_item(mode="units")
    raw = op("adjust", item, {"delta": 1}, v=2)
    assert apply(ctx(alice), raw)["reason"] == "unsupported_version"
    assert not InventoryEvent.objects.filter(client_op_id=raw["client_op_id"]).exists()


@pytest.mark.parametrize(
    "raw",
    [
        "not a dict",
        {"v": 1},
        {"v": 1, "client_op_id": "nope", "op": "buy", "target": str(uuid.uuid4())},
        {"v": 1, "client_op_id": str(uuid.uuid4()), "op": "explode", "target": str(uuid.uuid4())},
    ],
)
def test_malformed_operations_are_rejected(raw, ctx, alice):
    out = apply(ctx(alice), raw)
    assert (out["result"], out["reason"]) == ("rejected", "invalid")


def test_a_batch_applies_each_operation_on_its_own(make_item, ctx, alice, home, workspace):
    good = make_item(name="Good", mode="units")
    deleted = make_item(name="Deleted", mode="units")
    type(deleted).all_objects.filter(pk=deleted.pk).update(deleted_at=timezone.now())
    secret = Project.objects.create(name="Secret", identifier="SEC", workspace=workspace, inventory_view=True)
    forbidden = make_item(
        name="Forbidden",
        mode="units",
        inventory_list=type(good.inventory_list).objects.create(name="X", project=secret),
    )
    level = make_item(name="Level", mode="level")
    results = engine.apply_batch(
        [
            op("adjust", good, {"delta": 1}),
            op("adjust", deleted, {"delta": 1}),
            op("adjust", forbidden, {"delta": 1}),
            op("adjust", level, {"delta": 1}),
            op("adjust", good, {"delta": 1}),
        ],
        ctx(alice),
    )
    assert [r.get("reason", r["result"]) for r in results] == [
        "applied",
        "gone",
        "forbidden",
        "invalid_for_mode",
        "applied",
    ]
    assert fresh(good).quantity == 2


@pytest.mark.parametrize(
    "age_ms,expected_age", [(-5000, timedelta(0)), (10**13, engine.MAX_AGE), (60_000, timedelta(minutes=1))]
)
def test_age_is_clamped_and_only_shown(age_ms, expected_age, make_item, ctx, alice):
    item = make_item(mode="pinned")
    now = timezone.now()
    out = apply(ctx(alice, now=now), op("buy", item, age_ms=age_ms))
    event = InventoryEvent.objects.get(client_op_id=out["client_op_id"])
    assert event.occurred_at == now - expected_age


def test_an_older_purchase_delivered_late_does_not_pull_the_bought_time_back(make_item, ctx, alice, bob):
    """S19."""
    item = make_item(mode="pinned")
    apply(ctx(alice), op("buy", item))
    newer = fresh(item).last_bought_at
    apply(ctx(bob), op("buy", item, age_ms=86_400_000))
    item = fresh(item)
    assert item.last_bought_at == newer and item.last_bought_by_id == alice.id
