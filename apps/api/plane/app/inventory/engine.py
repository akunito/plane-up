# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# The operations engine (brief: "Operations and concurrency"). No HTTP in here; views stay thin.
#
# Two behaviours and no third. Do not add rules here: a case these do not cover is either an accepted
# behaviour written into the brief or a question for the person holding the phone (plan, ground rules).
#   ALWAYS  — things that happened: adjust, buy, mark_ordered, arrived, cancel.
#   CAS     — statements about the present, compared on base_rev with the same-queue exemption:
#             set_level, set_needed, pin, change_mode, recount. And revert, compared against the
#             revision the reverted operation produced.
#
# One operation = one transaction with a row lock on its item. No transaction around a batch, so two
# phones' batches cannot deadlock each other and one bad operation cannot undo the others.
# The event row is written in the same transaction as the state it records: its unique client_op_id
# then rolls back a racing duplicate, which is answered from the ledger.

import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import F
from django.db.models.functions import Coalesce

from plane.app.inventory.access import can_use_project
from plane.db.models import (
    InventoryEvent,
    InventoryItem,
    InventoryLevel,
    InventoryMode,
    InventoryOrder,
    InventoryOrderStatus,
)

OP_VERSION = 1
MAX_OPS = 100
MAX_AGE = timedelta(days=60)
# Bounds that keep every value inside its column, so a typo is answered "invalid" for that operation
# instead of a database error that fails the whole request and blocks the device queue (phase 2 audit).
MAX_QUANTITY = 1_000_000
MAX_REV = 2**62
ALWAYS = frozenset({"adjust", "buy", "mark_ordered", "arrived", "cancel"})
CAS = frozenset({"set_level", "set_needed", "pin", "change_mode", "recount"})
REVERTIBLE = frozenset({"adjust", "buy"}) | CAS
ALL_OPS = ALWAYS | CAS | {"revert"}

# Snapshotted into the event. A revert restores only the state ones (REVERT_FIELDS): min_quantity is
# item data, which a data edit may have changed since without a revision step (phase 2 audit).
STATE_FIELDS = (
    "mode",
    "needed",
    "needed_by_id",
    "needed_at",
    "level",
    "quantity",
    "min_quantity",
    "last_bought_at",
    "last_bought_by_id",
)
REVERT_FIELDS = ("mode", "needed", "needed_by_id", "needed_at", "level", "quantity")
_DATETIME_FIELDS = frozenset({"needed_at", "last_bought_at"})
_UUID_FIELDS = frozenset({"needed_by_id", "last_bought_by_id"})


@dataclass(frozen=True)
class Context:
    user: object
    workspace_id: uuid.UUID
    source: str  # "web" or "api"
    now: datetime


class _Invalid(Exception):
    pass


class _Rejected(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _uuid(value, field):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise _Invalid(field) from None


def _int(value, field, minimum=None, maximum=MAX_QUANTITY):
    if isinstance(value, bool) or not isinstance(value, int):
        raise _Invalid(field)
    if (minimum is not None and value < minimum) or value > maximum or value < -maximum:
        raise _Invalid(field)
    return value


def _parse(raw, ctx):
    if not isinstance(raw, dict):
        raise _Invalid("operation")
    if raw.get("v") != OP_VERSION:
        raise _Rejected("unsupported_version")
    op = raw.get("op")
    if op not in ALL_OPS:
        raise _Invalid("op")
    args = raw.get("args") or {}
    if not isinstance(args, dict):
        raise _Invalid("args")
    if "\x00" in json.dumps(args, ensure_ascii=False):
        raise _Invalid("args")  # jsonb refuses NUL; it would fail every insert of this operation
    queue_id = raw.get("queue_id")
    base_rev = raw.get("base_rev")
    if op in CAS:
        base_rev = _int(base_rev, "base_rev", 0, MAX_REV)
    elif base_rev is not None:
        base_rev = _int(base_rev, "base_rev", 0, MAX_REV)
    age_ms = raw.get("age_ms", 0)
    age_ms = age_ms if isinstance(age_ms, int) and not isinstance(age_ms, bool) else 0
    # Time is display-only (brief). Clamped to [0, 60 days] before timedelta(), which overflows on a
    # large enough integer; no rule depends on it.
    age = timedelta(milliseconds=min(max(age_ms, 0), int(MAX_AGE.total_seconds() * 1000)))
    return {
        "op": op,
        "target": _uuid(raw.get("target"), "target"),
        "queue_id": _uuid(queue_id, "queue_id") if queue_id is not None else None,
        "args": args,
        "base_rev": base_rev,
        "occurred_at": ctx.now - age,
    }


def _jsonable(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def _snapshot(item):
    return {f: _jsonable(getattr(item, f)) for f in STATE_FIELDS}


def _restore(item, snap, fields):
    for f in fields:
        value = snap.get(f)
        if value is not None and f in _DATETIME_FIELDS:
            value = datetime.fromisoformat(value)
        elif value is not None and f in _UUID_FIELDS:
            value = uuid.UUID(value)
        setattr(item, f, value)


def item_state(item):
    return {
        "id": str(item.pk),
        "rev": item.state_rev,
        "mode": item.mode,
        "needed": item.needed,
        "level": item.level,
        "quantity": item.quantity,
        "min_quantity": item.min_quantity,
        "restock_to": item.restock_to,
        "last_bought_at": _jsonable(item.last_bought_at),
        "last_bought_by": _jsonable(item.last_bought_by_id),
    }


# ---------------------------------------------------------------- handlers
# Each takes the locked item and returns (changed_fields, previous_extra, order). Raise _Rejected for
# an operation that cannot apply; nothing is written then except the ledger row.


def _require_mode(item, *modes):
    if item.mode not in modes:
        raise _Rejected("invalid_for_mode")


def _buy_effect(item, quantity, ctx, occurred_at, stamp_orders=True):
    """A purchase, applied according to the item's mode at the moment it is applied (brief)."""
    changed = ["last_bought_at", "last_bought_by"]
    extra = {"quantity_delta": 0, "stamped_orders": []}
    if item.mode == InventoryMode.ON_DEMAND:
        item.needed, item.needed_by, item.needed_at = False, None, None
        changed += ["needed", "needed_by", "needed_at"]
    elif item.mode == InventoryMode.LEVEL:
        item.level = InventoryLevel.OK
        changed.append("level")
    elif item.mode == InventoryMode.UNITS:
        item.quantity = Coalesce(F("quantity"), 0) + quantity
        changed.append("quantity")
        extra["quantity_delta"] = quantity
    # Only moves forward (brief); a late, older purchase does not pull it back (S19).
    if item.last_bought_at is None or occurred_at > item.last_bought_at:
        item.last_bought_at, item.last_bought_by = occurred_at, ctx.user
    # "Bought since it was ordered": the first purchase while an order is open stamps it (brief, Orders).
    # An arrival is an order being fulfilled, not a purchase: it stamps nothing (phase 2 audit, S15).
    stamped = []
    if stamp_orders:
        open_orders = InventoryOrder.objects.filter(
            item=item, status=InventoryOrderStatus.OPEN, bought_since_at__isnull=True
        )
        stamped = [str(pk) for pk in open_orders.values_list("pk", flat=True)]
        if stamped:
            open_orders.update(bought_since_at=ctx.now, bought_since_by=ctx.user)
    extra["stamped_orders"] = stamped
    extra["stamped_at"] = ctx.now.isoformat()
    return changed, extra


def _op_adjust(item, args, ctx, parsed):
    _require_mode(item, InventoryMode.UNITS)
    delta = _int(args.get("delta"), "delta")
    if delta == 0:
        raise _Invalid("delta")
    item.quantity = Coalesce(F("quantity"), 0) + delta
    return ["quantity"], {"quantity_delta": delta}, None


def _op_buy(item, args, ctx, parsed):
    quantity = _int(args.get("quantity", 1), "quantity", 1)
    changed, extra = _buy_effect(item, quantity, ctx, parsed["occurred_at"])
    return changed, extra, None


def _op_mark_ordered(item, args, ctx, parsed):
    order_id = _uuid(args.get("order_id"), "order_id")
    quantity = _int(args.get("quantity", 1), "quantity", 1)
    reference = args.get("reference") or ""
    if not isinstance(reference, str) or len(reference) > 255:
        raise _Invalid("reference")
    expected_on = args.get("expected_on")
    if expected_on is not None:
        try:
            expected_on = date.fromisoformat(expected_on)
        except (TypeError, ValueError):
            raise _Invalid("expected_on") from None
    if InventoryOrder.all_objects.filter(pk=order_id).exists():
        raise _Rejected("already_done")
    order = InventoryOrder.objects.create(
        id=order_id,
        item=item,
        project=item.project,
        quantity=quantity,
        reference=reference,
        expected_on=expected_on,
        source=ctx.source,
        ordered_by=ctx.user,
        ordered_at=parsed["occurred_at"],
    )
    return [], {}, order


def _locked_order(item, args):
    order_id = _uuid(args.get("order_id"), "order_id")
    order = InventoryOrder.objects.select_for_update().filter(pk=order_id, item=item).first()
    if order is None:
        raise _Rejected("gone")
    return order


def _op_arrived(item, args, ctx, parsed):
    order = _locked_order(item, args)
    # open → received and cancelled → received ("the parcel came anyway"); nothing leaves received.
    if order.status == InventoryOrderStatus.RECEIVED:
        raise _Rejected("already_done")
    quantity = _int(args.get("quantity", order.quantity), "quantity", 1)
    order.status, order.received_quantity = InventoryOrderStatus.RECEIVED, quantity
    order.received_by, order.received_at = ctx.user, ctx.now
    order.save(update_fields=["status", "received_quantity", "received_by", "received_at", "updated_at"])
    changed, extra = _buy_effect(item, quantity, ctx, parsed["occurred_at"], stamp_orders=False)
    return changed, extra, order


def _op_cancel(item, args, ctx, parsed):
    order = _locked_order(item, args)
    if order.status != InventoryOrderStatus.OPEN:
        raise _Rejected("already_done")
    order.status, order.cancelled_by, order.cancelled_at = InventoryOrderStatus.CANCELLED, ctx.user, ctx.now
    order.save(update_fields=["status", "cancelled_by", "cancelled_at", "updated_at"])
    return [], {}, order


def _op_set_level(item, args, ctx, parsed):
    _require_mode(item, InventoryMode.LEVEL)
    level = args.get("level")
    if level not in InventoryLevel.values:
        raise _Invalid("level")
    item.level = level
    return ["level"], {}, None


def _op_set_needed(item, args, ctx, parsed):
    _require_mode(item, InventoryMode.ON_DEMAND)
    needed = args.get("needed")
    if not isinstance(needed, bool):
        raise _Invalid("needed")
    item.needed = needed
    item.needed_by, item.needed_at = (ctx.user, ctx.now) if needed else (None, None)
    return ["needed", "needed_by", "needed_at"], {}, None


def _op_pin(item, args, ctx, parsed):
    pinned = args.get("pinned")
    if not isinstance(pinned, bool):
        raise _Invalid("pinned")
    _require_mode(item, InventoryMode.PINNED, InventoryMode.ON_DEMAND)
    # Pinning clears `needed`; unpinning gives on_demand with needed = false (brief).
    item.mode = InventoryMode.PINNED if pinned else InventoryMode.ON_DEMAND
    item.needed, item.needed_by, item.needed_at = False, None, None
    return ["mode", "needed", "needed_by", "needed_at"], {}, None


def _op_change_mode(item, args, ctx, parsed):
    mode = args.get("mode")
    if mode not in InventoryMode.values:
        raise _Invalid("mode")
    if mode == item.mode:
        raise _Rejected("invalid_for_mode")
    changed = ["mode", "needed", "needed_by", "needed_at", "level", "quantity"]
    # Clears the state fields the new mode does not use; min_quantity and restock_to are data and stay.
    item.mode = mode
    item.needed, item.needed_by, item.needed_at = False, None, None
    item.level = None
    item.quantity = None
    if mode == InventoryMode.LEVEL:
        level = args.get("level", InventoryLevel.OK)
        if level not in InventoryLevel.values:
            raise _Invalid("level")
        item.level = level
    elif mode == InventoryMode.UNITS:
        # Carries the quantity typed by the user: a recount, never a leftover. An empty minimum
        # becomes 1, or the item could never reach the list (brief).
        item.quantity = _int(args.get("quantity"), "quantity")
        if item.min_quantity is None:
            item.min_quantity = 1
            changed.append("min_quantity")
    return changed, {}, None


def _op_recount(item, args, ctx, parsed):
    _require_mode(item, InventoryMode.UNITS)
    item.quantity = _int(args.get("quantity"), "quantity")
    return ["quantity"], {}, None


def _op_revert(item, args, ctx, parsed):
    target = _uuid(args.get("reverts"), "reverts")
    event = InventoryEvent.objects.select_for_update().filter(client_op_id=target, item=item).first()
    if event is None:
        raise _Rejected("gone")
    if event.actor_id != ctx.user.id:
        raise _Rejected("not_yours")  # undo belongs to the device that tapped (brief)
    if event.result != "applied" or event.op not in REVERTIBLE:
        raise _Rejected("not_revertible")
    if event.reverted_at is not None:
        raise _Rejected("already_done")
    # "Only if the item has not changed since that operation, whatever revision the device holds."
    # Refused, not stale: "apply anyway" exists only for stale, and a revert never could (brief).
    if item.state_rev != event.resulting_rev:
        raise _Rejected("changed_since")
    previous = event.previous or {}
    delta = previous.get("quantity_delta") or 0
    changed = []
    if event.op == "adjust" or (event.op == "buy" and delta):
        item.quantity = Coalesce(F("quantity"), 0) - delta
        changed.append("quantity")
    if event.op == "buy":
        # The last-bought time moves back only here, when the purchase that set it is reverted.
        restore = ["needed", "needed_by_id", "needed_at", "level", "last_bought_at", "last_bought_by_id"]
        _restore(item, previous["state"], restore)
        changed += ["needed", "needed_by", "needed_at", "level", "last_bought_at", "last_bought_by"]
        if previous.get("stamped_orders"):
            InventoryOrder.objects.filter(
                pk__in=previous["stamped_orders"], bought_since_at=datetime.fromisoformat(previous["stamped_at"])
            ).update(bought_since_at=None, bought_since_by=None)
    elif event.op in CAS:
        _restore(item, previous["state"], REVERT_FIELDS)
        changed += ["mode", "needed", "needed_by", "needed_at", "level", "quantity"]
    event.reverted_at = ctx.now
    event.save(update_fields=["reverted_at"])
    return changed, {}, None


class _Stale(Exception):
    pass


HANDLERS = {
    "adjust": _op_adjust,
    "buy": _op_buy,
    "mark_ordered": _op_mark_ordered,
    "arrived": _op_arrived,
    "cancel": _op_cancel,
    "set_level": _op_set_level,
    "set_needed": _op_set_needed,
    "pin": _op_pin,
    "change_mode": _op_change_mode,
    "recount": _op_recount,
    "revert": _op_revert,
}


# ---------------------------------------------------------------- compare-and-set


def _changed_by_someone_else(item, base_rev, ctx, queue_id):
    """True when the item's state moved since base_rev because of anyone but this person on this queue.

    Proven, not inferred from absence: every applied operation writes one event with its resulting
    revision, so the steps between base_rev and now must be exactly those events. A missing one (pruned,
    or a revision this ledger cannot explain) counts as someone else's change."""
    if base_rev == item.state_rev:
        return False
    if base_rev > item.state_rev or queue_id is None:
        return True
    steps = list(
        InventoryEvent.objects.filter(
            item=item, result="applied", resulting_rev__gt=base_rev, resulting_rev__lte=item.state_rev
        ).values_list("actor_id", "queue_id")
    )
    if len(steps) != item.state_rev - base_rev:
        return True
    return any(actor != ctx.user.id or queue != queue_id for actor, queue in steps)


def _last_change(item):
    event = (
        InventoryEvent.objects.filter(item=item, result="applied")
        .select_related("actor")
        .order_by("-resulting_rev")
        .first()
    )
    if event is None:
        return None
    return {
        "op": event.op,
        "by": _jsonable(event.actor_id),
        "by_name": event.actor.display_name if event.actor else None,
        "at": _jsonable(event.occurred_at),
    }


# ---------------------------------------------------------------- one operation


def _record(ctx, parsed, raw, result, reason="", item=None, previous=None, resulting_rev=None, order=None):
    return InventoryEvent.objects.create(
        client_op_id=uuid.UUID(str(raw["client_op_id"])),
        workspace_id=ctx.workspace_id,
        project=item.project if item is not None else None,
        item=item,
        order=order,
        actor=ctx.user,
        queue_id=parsed.get("queue_id") if parsed else None,
        op=(parsed or {}).get("op") or str(raw.get("op"))[:32],
        version=OP_VERSION,
        args=raw.get("args") if isinstance(raw.get("args"), dict) else {},
        base_rev=(parsed or {}).get("base_rev"),
        result=result,
        reason=reason,
        previous=previous,
        resulting_rev=resulting_rev,
        source=ctx.source,
        occurred_at=(parsed or {}).get("occurred_at") or ctx.now,
    )


def _answer(event, duplicate=False, item=None):
    out = {"client_op_id": str(event.client_op_id), "result": event.result}
    if event.reason:
        out["reason"] = event.reason
    if duplicate:
        out["duplicate"] = True
    if event.order_id:
        out["order_id"] = str(event.order_id)
    if item is not None:
        out["item"] = item_state(item)
    return out


def _record_outside(ctx, parsed, raw, result, reason, item=None):
    """Record a refusal that touched no state. A duplicate delivery of one is answered afresh, after the
    authorisation check, so nothing old is replayed to someone who has lost access."""
    try:
        with transaction.atomic():
            _record(ctx, parsed, raw, result, reason, item=item)
    except IntegrityError:
        pass
    out = {"client_op_id": str(raw["client_op_id"]), "result": result, "reason": reason}
    if item is not None:
        out["item"] = item_state(item)
    return out


def apply_operation(raw, ctx):
    if not isinstance(raw, dict) or raw.get("client_op_id") is None:
        return {"client_op_id": None, "result": "rejected", "reason": "invalid"}
    try:
        client_op_id = uuid.UUID(str(raw["client_op_id"]))
    except (TypeError, ValueError):
        return {"client_op_id": str(raw.get("client_op_id"))[:64], "result": "rejected", "reason": "invalid"}
    try:
        parsed = _parse(raw, ctx)
    except _Rejected as e:
        return {"client_op_id": str(client_op_id), "result": "rejected", "reason": e.reason}
    except _Invalid as e:
        return {"client_op_id": str(client_op_id), "result": "rejected", "reason": "invalid", "field": str(e)}

    # Authorisation first, against the item's CURRENT project (brief).
    item = (
        InventoryItem.all_objects.filter(pk=parsed["target"], workspace_id=ctx.workspace_id)
        .select_related("project", "inventory_list")
        .first()
    )
    if (
        item is None
        or item.deleted_at is not None
        or item.inventory_list.deleted_at is not None
        or item.project.deleted_at is not None
    ):
        return _record_outside(ctx, parsed, raw, "rejected", "gone")
    if not can_use_project(ctx.user, item.project):
        return _record_outside(ctx, parsed, raw, "rejected", "forbidden")

    # Then the ledger: a duplicate delivery returns the recorded result, marked as a duplicate.
    existing = InventoryEvent.objects.filter(client_op_id=client_op_id).first()
    if existing is not None:
        if existing.actor_id != ctx.user.id or existing.item_id != item.pk:
            return {"client_op_id": str(client_op_id), "result": "rejected", "reason": "duplicate_id"}
        item.refresh_from_db()
        return _answer(existing, duplicate=True, item=item)

    try:
        with transaction.atomic():
            locked = InventoryItem.objects.select_for_update().select_related("project").get(pk=item.pk)
            before = _snapshot(locked)
            op = parsed["op"]
            if op in CAS and _changed_by_someone_else(locked, parsed["base_rev"], ctx, parsed["queue_id"]):
                raise _Stale()
            try:
                changed, extra, order = HANDLERS[op](locked, parsed["args"], ctx, parsed)
            except _Invalid as e:
                raise _Rejected("invalid") from e
            locked.state_rev = F("state_rev") + 1
            locked.save(update_fields=[*dict.fromkeys(changed), "state_rev", "updated_at"])
            locked.refresh_from_db()
            event = _record(
                ctx,
                parsed,
                raw,
                "applied",
                item=locked,
                previous={"state": before, **extra},
                resulting_rev=locked.state_rev,
                order=order,
            )
            return _answer(event, item=locked)
    except _Stale:
        try:
            with transaction.atomic():
                event = _record(ctx, parsed, raw, "stale", item=item)
        except IntegrityError:
            # A racing duplicate recorded first (always so for a queueless one: the first copy applied,
            # the second sees it as someone else's change). Answer from the ledger, as for applied.
            item.refresh_from_db()
            return _answer(InventoryEvent.objects.get(client_op_id=client_op_id), duplicate=True, item=item)
        item.refresh_from_db()
        out = _answer(event, item=item)
        out["changed"] = _last_change(item)
        return out
    except _Rejected as e:
        try:
            with transaction.atomic():
                event = _record(ctx, parsed, raw, "rejected", e.reason, item=item)
        except IntegrityError:
            item.refresh_from_db()
            return _answer(InventoryEvent.objects.get(client_op_id=client_op_id), duplicate=True, item=item)
        item.refresh_from_db()
        return _answer(event, item=item)
    except IntegrityError:
        # A racing delivery of the same client_op_id committed first; answer from the ledger.
        existing = InventoryEvent.objects.filter(client_op_id=client_op_id).first()
        if existing is not None:
            item.refresh_from_db()
            return _answer(existing, duplicate=True, item=item)
        return _db_refused(client_op_id)
    except DatabaseError:
        return _db_refused(client_op_id)


def _db_refused(client_op_id):
    # Anything the database refuses (a CHECK, a dangling user, a racing order id) is this operation's
    # problem, not the batch's: answered on its own, nothing written, the rest of the batch goes on.
    return {"client_op_id": str(client_op_id), "result": "rejected", "reason": "invalid"}


def apply_batch(ops, ctx):
    return [apply_operation(raw, ctx) for raw in ops]
