# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Randomized histories (plan, phase 2). Two people, each with a phone queue and a queueless surface
(widget or MCP), plus the two of them sharing one phone under separate queue ids; offline periods mean
operations are built against old revisions and delivered later, in any order the per-queue FIFO allows,
and some are delivered twice (a retry after a lost answer).

Invariants checked after every history:
- no operation takes effect twice: one ledger row per client_op_id, duplicates flagged;
- `units` totals equal the sum of the applied deltas and purchases, whatever the delivery order;
- a delivered purchase is never lost (always applied on a live, visible item);
- a statement never overwrites a change its author had not seen: every step between its base_rev and
  its own revision was made by the same person on the same queue.
"""

import random
import uuid

import pytest

from plane.app.inventory import engine
from plane.db.models import InventoryEvent

from .conftest import fresh, op

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

SEEDS = range(12)


def _history(rng, people, items, known_rev):
    """One device's queue: operations built against what that device last saw."""
    queue = []
    for _ in range(rng.randint(3, 8)):
        item = rng.choice(items)
        seen = known_rev[item.pk]
        if item.mode == "units":
            kind = rng.choice(["adjust", "buy", "recount"])
            if kind == "adjust":
                queue.append(op("adjust", item, {"delta": rng.choice([-2, -1, 1, 2, 3])}))
            elif kind == "buy":
                queue.append(op("buy", item, {"quantity": rng.randint(1, 3)}))
            else:
                queue.append(op("recount", item, {"quantity": rng.randint(0, 6)}, base_rev=seen))
        else:
            kind = rng.choice(["buy", "set_level"])
            if kind == "buy":
                queue.append(op("buy", item))
            else:
                queue.append(op("set_level", item, {"level": rng.choice(["ok", "low", "out"])}, base_rev=seen))
    return queue


@pytest.mark.parametrize("seed", SEEDS)
def test_random_histories_keep_the_invariants(seed, make_item, ctx, alice, bob):
    rng = random.Random(seed)
    items = [make_item(name=f"U{i}", mode="units", quantity=0) for i in range(2)] + [
        make_item(name="L", mode="level", level="ok")
    ]
    start = {i.pk: fresh(i).state_rev for i in items}

    # Devices: (person, queue_id). Queueless surfaces get a fresh id per operation.
    devices = [
        (alice, uuid.uuid4()),  # alice's phone
        (bob, uuid.uuid4()),  # bob's phone
        (alice, uuid.uuid4()),  # the shared phone, alice signed in
        (bob, uuid.uuid4()),  # the shared phone, bob signed in
    ]
    queues = []
    for person, queue_id in devices:
        ops = _history(rng, [person], items, start)  # offline from the start: all built on old revisions
        for raw in ops:
            raw["queue_id"] = str(queue_id)
        queues.append((person, ops))
    for person in (alice, bob):  # queueless: widget / MCP, one fresh id per request
        ops = _history(rng, [person], items, start)
        for raw in ops:
            raw["queue_id"] = str(uuid.uuid4())
        queues.append((person, ops))

    # Interleave respecting FIFO per queue; sometimes deliver an operation twice.
    cursors = [0] * len(queues)
    delivered = []
    while any(c < len(q[1]) for c, q in zip(cursors, queues)):
        i = rng.choice([k for k, (c, q) in enumerate(zip(cursors, queues)) if c < len(q[1])])
        person, ops = queues[i]
        raw = ops[cursors[i]]
        out = engine.apply_operation(dict(raw), ctx(person))
        delivered.append((person, raw, out))
        if rng.random() < 0.2:
            again = engine.apply_operation(dict(raw), ctx(person))
            assert again.get("duplicate") is True and again["result"] == out["result"], (raw, out, again)
        cursors[i] += 1

    # No operation takes effect twice.
    ids = [raw["client_op_id"] for _, raw, _ in delivered]
    assert InventoryEvent.objects.filter(client_op_id__in=ids).count() == len(set(ids))

    # Purchases and deltas are never lost; nothing else is ever refused here.
    for person, raw, out in delivered:
        if raw["op"] in ("adjust", "buy"):
            assert out["result"] == "applied", (raw, out)
        assert out["result"] in ("applied", "stale"), (raw, out)

    # Units totals: replay what was applied, in revision order, against a model.
    for item in items:
        if item.mode != "units":
            continue
        events = InventoryEvent.objects.filter(item=item, result="applied").order_by("resulting_rev")
        model = 0
        for event in events:
            if event.op == "adjust":
                model += event.args["delta"]
            elif event.op == "buy":
                model += event.args.get("quantity", 1)
            elif event.op == "recount":
                model = event.args["quantity"]
        assert fresh(item).quantity == model

    # Revisions advance by exactly one per applied operation.
    for item in items:
        applied = InventoryEvent.objects.filter(item=item, result="applied").count()
        assert fresh(item).state_rev == start[item.pk] + applied

    # A statement never overwrites a change its author had not seen.
    for event in InventoryEvent.objects.filter(item__in=items, result="applied", op__in=engine.CAS):
        between = InventoryEvent.objects.filter(
            item=event.item, result="applied", resulting_rev__gt=event.base_rev, resulting_rev__lt=event.resulting_rev
        )
        for step in between:
            assert (step.actor_id, step.queue_id) == (event.actor_id, event.queue_id), (event.op, step.op)
