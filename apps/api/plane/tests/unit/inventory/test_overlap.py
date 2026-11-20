# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Real overlap (plan, phase 2): real transactions, two connections at once, released together by a
barrier. transaction=True so each thread's work commits and the row locks are real."""

import threading
import uuid

import pytest
from django.db import connection, connections

from plane.app.inventory import engine
from plane.db.models import InventoryEvent

from .conftest import fresh, op

pytestmark = [pytest.mark.unit, pytest.mark.django_db(transaction=True)]


def run_together(*jobs):
    """Run each job in its own thread and connection, released at the same instant."""
    barrier = threading.Barrier(len(jobs))
    results = [None] * len(jobs)
    errors = []

    def worker(i, job):
        try:
            barrier.wait(timeout=10)
            results[i] = job()
        except Exception as e:  # surfaced below; a thread's exception is otherwise lost
            errors.append(e)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(i, job)) for i, job in enumerate(jobs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads), "a thread is stuck: deadlock or lock wait"
    assert not errors, errors
    return results


def test_two_deltas_at_once_both_count(make_item, ctx, alice, bob):
    item = make_item(mode="units", quantity=0)
    run_together(
        lambda: engine.apply_operation(op("adjust", item, {"delta": 2}), ctx(alice)),
        lambda: engine.apply_operation(op("adjust", item, {"delta": 3}), ctx(bob)),
    )
    item = fresh(item)
    assert (item.quantity, item.state_rev) == (5, 2)


def test_two_statements_at_once_one_applies_one_is_stale(make_item, ctx, alice, bob):
    item = make_item(mode="level")
    results = run_together(
        lambda: engine.apply_operation(
            op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4()), ctx(alice)
        ),
        lambda: engine.apply_operation(
            op("set_level", item, {"level": "ok"}, base_rev=0, queue=uuid.uuid4()), ctx(bob)
        ),
    )
    assert sorted(r["result"] for r in results) == ["applied", "stale"]
    assert fresh(item).state_rev == 1


def test_the_same_operation_twice_at_once_takes_effect_once(make_item, ctx, alice):
    item = make_item(mode="units", quantity=0)
    raw = op("adjust", item, {"delta": 1})
    results = run_together(
        lambda: engine.apply_operation(dict(raw), ctx(alice)),
        lambda: engine.apply_operation(dict(raw), ctx(alice)),
    )
    assert sorted(bool(r.get("duplicate")) for r in results) == [False, True]
    assert all(r["result"] == "applied" for r in results)
    assert fresh(item).quantity == 1
    assert InventoryEvent.objects.filter(client_op_id=raw["client_op_id"]).count() == 1


def test_two_batches_touching_two_items_in_opposite_order_do_not_deadlock(make_item, ctx, alice, bob):
    a, b = make_item(name="A", mode="units"), make_item(name="B", mode="units")
    batch_1 = [op("adjust", a, {"delta": 1}) for _ in range(5)] + [op("adjust", b, {"delta": 1}) for _ in range(5)]
    batch_2 = [op("adjust", b, {"delta": 1}) for _ in range(5)] + [op("adjust", a, {"delta": 1}) for _ in range(5)]
    run_together(lambda: engine.apply_batch(batch_1, ctx(alice)), lambda: engine.apply_batch(batch_2, ctx(bob)))
    assert (fresh(a).quantity, fresh(b).quantity) == (10, 10)


def test_overlap_tests_use_real_transactions():
    assert not connection.in_atomic_block, "with transaction=False the threads would share nothing real"


@pytest.mark.parametrize("queue", ["queueless", "queued"])
def test_the_same_statement_twice_at_once_is_answered_twice_and_applied_once(queue, make_item, ctx, alice):
    """Phase 2 audit: a racing duplicate of a queueless statement used to see its twin's step as someone
    else's change, go stale, collide on client_op_id and fail the whole request with a 400."""
    item = make_item(mode="level")
    raw = op("set_level", item, {"level": "out"}, base_rev=0, queue=uuid.uuid4() if queue == "queued" else None)
    results = run_together(
        lambda: engine.apply_operation(dict(raw), ctx(alice)),
        lambda: engine.apply_operation(dict(raw), ctx(alice)),
    )
    assert all(r["result"] == "applied" for r in results), results
    assert sorted(bool(r.get("duplicate")) for r in results) == [False, True]
    assert fresh(item).state_rev == 1
    assert InventoryEvent.objects.filter(client_op_id=raw["client_op_id"]).count() == 1
