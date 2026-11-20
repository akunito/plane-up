# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Inventory endpoints (APLANE-60). Thin: state changes go through plane.app.inventory.engine, visibility
# through plane.app.inventory.access. Session or API key; guests get 403 everywhere.

import uuid
from datetime import date
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, IntegerField, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.api.rate_limit import ApiKeyRateThrottle
from plane.app.inventory import engine
from plane.bgtasks.deletion_task import soft_delete_related_objects
from plane.app.inventory.access import (
    MEMBER_ROLES,
    can_use_project,
    is_inventory_member,
    visible_items,
    visible_lists,
    visible_projects,
)
from plane.app.inventory.derive import OVERDUE_AFTER, counts, to_buy
from plane.api.middleware.api_authentication import APIKeyAuthentication as ApiKeyAuth
from plane.app.middleware.api_authentication import APIKeyAuthentication as AppApiKeyAuth
from plane.db.models import (
    InventoryEvent,
    InventoryItem,
    InventoryLevel,
    InventoryList,
    InventoryMode,
    InventoryOrder,
    InventoryOrderStatus,
    InventoryPreference,
    Project,
    ProjectMember,
    Workspace,
    WorkspaceMember,
)
from plane.db.models.inventory import normalise_item_name

from .base import BaseAPIView

GROUPINGS = ("category", "store", "list", "urgency")
# Writable through the item endpoints. State fields are not here on purpose: only operations write state.
ITEM_DATA_FIELDS = (
    "name",
    "category",
    "store",
    "buy_online",
    "purchase_url",
    "variant",
    "last_price",
    "currency",
    "expires_on",
    "barcode",
    "sort_order",
    "min_quantity",
    "restock_to",
    "external_source",
    "external_id",
)
ITEM_STATE_FIELDS = frozenset(
    {"mode", "needed", "needed_by", "needed_at", "level", "quantity", "last_bought_at", "last_bought_by", "state_rev"}
)


def _forbidden():
    return Response({"error": "You don't have the required permissions."}, status=status.HTTP_403_FORBIDDEN)


def _bad(field, message="invalid"):
    return Response({"error": message, "field": field}, status=status.HTTP_400_BAD_REQUEST)


class InventoryBaseView(BaseAPIView):
    throttle_classes = [ApiKeyRateThrottle]

    def _source(self, request):
        # Two identical classes exist; BaseAPIView uses plane.api's (measured: checking only the other
        # recorded every API-key request as "web").
        authenticator = getattr(request, "successful_authenticator", None)
        return "api" if isinstance(authenticator, (ApiKeyAuth, AppApiKeyAuth)) else "web"

    def _workspace(self, slug):
        return Workspace.objects.filter(slug=slug).first()


def item_payload(item, on_order=0, has_open=False):
    return {
        "id": str(item.pk),
        "name": item.name,
        "mode": item.mode,
        "rev": item.state_rev,
        "list": {"id": str(item.inventory_list_id), "name": item.inventory_list.name},
        "project": {"id": str(item.project_id), "name": item.project.name, "identifier": item.project.identifier},
        "needed": item.needed,
        "needed_by": str(item.needed_by_id) if item.needed_by_id else None,
        "needed_at": item.needed_at.isoformat() if item.needed_at else None,
        "level": item.level,
        "quantity": item.quantity,
        "min_quantity": item.min_quantity,
        "restock_to": item.restock_to,
        "category": item.category,
        "store": item.store,
        "buy_online": item.buy_online,
        "purchase_url": item.purchase_url,
        "variant": item.variant,
        "last_price": str(item.last_price) if item.last_price is not None else None,
        "currency": item.currency,
        "expires_on": item.expires_on.isoformat() if item.expires_on else None,
        "barcode": item.barcode,
        "sort_order": item.sort_order,
        "last_bought_at": item.last_bought_at.isoformat() if item.last_bought_at else None,
        "last_bought_by": str(item.last_bought_by_id) if item.last_bought_by_id else None,
        "on_order": on_order,
        "to_buy": to_buy(
            item.mode, item.needed, item.level, item.quantity, item.min_quantity, item.restock_to, on_order, has_open
        ),
    }


def order_payload(order, now):
    return {
        "id": str(order.pk),
        "item": str(order.item_id),
        "item_name": order.item.name,
        "quantity": order.quantity,
        "status": order.status,
        "source": order.source,
        "reference": order.reference,
        "expected_on": order.expected_on.isoformat() if order.expected_on else None,
        "ordered_at": order.ordered_at.isoformat(),
        "ordered_by": str(order.ordered_by_id) if order.ordered_by_id else None,
        # Server time, not the device's: overdue is a rule, and no rule depends on device time.
        "overdue": order.status == InventoryOrderStatus.OPEN and order.created_at < now - OVERDUE_AFTER,
        "bought_since_at": order.bought_since_at.isoformat() if order.bought_since_at else None,
        "bought_since_by": str(order.bought_since_by_id) if order.bought_since_by_id else None,
    }


def with_orders(items):
    open_orders = InventoryOrder.objects.filter(item=OuterRef("pk"), status=InventoryOrderStatus.OPEN).order_by()
    total = open_orders.values("item").annotate(total=Sum("quantity")).values("total")
    return items.annotate(
        on_order=Coalesce(Subquery(total, output_field=IntegerField()), Value(0)),
        open_count=Coalesce(
            Subquery(open_orders.values("item").annotate(n=Count("pk")).values("n"), output_field=IntegerField()),
            Value(0),
        ),
    ).select_related("inventory_list", "project")


# ---------------------------------------------------------------- workspace level


class InventoryShoppingListEndpoint(InventoryBaseView):
    def get(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        now = timezone.now()
        rows = []
        count = 0
        for item in with_orders(visible_items(request.user, workspace.pk)).order_by("category", "name_normalised"):
            payload = item_payload(item, item.on_order, item.open_count > 0)
            if payload["to_buy"]:
                rows.append(payload)
                count += counts(item.mode)
        on_the_way = list(
            InventoryOrder.objects.filter(
                status=InventoryOrderStatus.OPEN, item__in=visible_items(request.user, workspace.pk)
            )
            .select_related("item")
            .order_by("created_at")
        )
        # Items fully covered by an order are not on the to-buy list, yet "Arrived" and "Cancel" are
        # operations on them: the device needs their state (revision included) to queue those.
        listed = {row["id"] for row in rows}
        waiting = {o.item_id for o in on_the_way if str(o.item_id) not in listed}
        on_the_way_items = []
        if waiting:
            for item in with_orders(visible_items(request.user, workspace.pk).filter(pk__in=waiting)):
                on_the_way_items.append(item_payload(item, item.on_order, item.open_count > 0))
        return Response(
            {
                "items": rows,
                "count": count,
                "on_the_way": [order_payload(o, now) for o in on_the_way],
                "on_the_way_items": on_the_way_items,
                "generated_at": now.isoformat(),
            }
        )


class InventoryOpsEndpoint(InventoryBaseView):
    def post(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        ops = request.data.get("ops") if isinstance(request.data, dict) else None
        if not isinstance(ops, list) or not ops:
            return _bad("ops")
        if len(ops) > engine.MAX_OPS:
            return _bad("ops", f"at most {engine.MAX_OPS} operations per request")
        ctx = engine.Context(
            user=request.user, workspace_id=workspace.pk, source=self._source(request), now=timezone.now()
        )
        return Response({"results": engine.apply_batch(ops, ctx)})


class InventorySuggestionsEndpoint(InventoryBaseView):
    def get(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        items = visible_items(request.user, workspace.pk)
        query = normalise_item_name(request.query_params.get("q", ""))[:100]
        matches = []
        if query:
            found = with_orders(items.filter(name_normalised__contains=query)).order_by("name_normalised")[:20]
            matches = [item_payload(i, i.on_order, i.open_count > 0) for i in found]
        # order_by() on the field itself: Meta.ordering would join the DISTINCT and the cap would count
        # items, not values (measured against Django 5.2.15 by the phase 2 audit).
        categories = list(
            items.exclude(category="").order_by("category").values_list("category", flat=True).distinct()[:200]
        )
        stores = list(items.exclude(store="").order_by("store").values_list("store", flat=True).distinct()[:200])
        return Response({"items": matches, "categories": categories, "stores": stores})


class InventoryCategoryRenameEndpoint(InventoryBaseView):
    """Renames a category on every item the requester may edit (all their inventory projects in this
    workspace), matching without regard to case or spacing, and in their own aisle order.
    Other people's aisle orders are theirs (brief: the aisle order is per user). A data edit: no revision."""

    def post(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        source, target = request.data.get("from"), request.data.get("to")
        if not isinstance(source, str) or not source.strip() or len(source) > 255:
            return _bad("from")
        if not isinstance(target, str) or not target.strip() or len(target) > 255:
            return _bad("to")
        source, target = " ".join(source.split()), " ".join(target.split())
        key = source.lower()
        items = visible_items(request.user, workspace.pk)
        # Matched the way the app groups categories (case and every run of spaces aside, phase 5 audit), so
        # every spelling shown as one group is renamed; a database comparison would miss inner spaces.
        spellings = [
            c
            for c in items.exclude(category="").order_by("category").values_list("category", flat=True).distinct()
            if " ".join(c.split()).lower() == key
        ]
        renamed = items.filter(category__in=spellings).update(category=target, updated_at=timezone.now())
        pref = InventoryPreference.objects.filter(workspace=workspace, user=request.user).first()
        if pref is not None and pref.category_order:
            order, seen = [], set()
            for entry in pref.category_order:
                value = target if " ".join(entry.split()).lower() == key else entry
                if value.lower() not in seen:
                    seen.add(value.lower())
                    order.append(value)
            if order != pref.category_order:
                pref.category_order = order
                pref.save(update_fields=["category_order", "updated_at"])
        return Response({"renamed": renamed})


class InventoryListsEndpoint(InventoryBaseView):
    """Every list the viewer can see, and who else can see each one (brief: Privacy). The app needs the
    lists without knowing the projects, and the people's names for "bought by" and "flagged by"."""

    def get(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        projects = list(visible_projects(request.user, workspace.pk).order_by("name"))
        ids = [p.pk for p in projects]
        members = {}
        # Who can see a project's lists is exactly who passes visible_projects: active project Members
        # and Admins who are also active workspace Members or Admins (a workspace guest never does).
        workspace_members = WorkspaceMember.objects.filter(
            workspace=workspace, is_active=True, role__in=MEMBER_ROLES
        ).values("member_id")
        for row in (
            ProjectMember.objects.filter(
                project_id__in=ids, is_active=True, role__in=MEMBER_ROLES, member_id__in=workspace_members
            )
            .order_by("member__display_name")
            .values("project_id", "member_id", "member__display_name")
        ):
            members.setdefault(row["project_id"], []).append(
                {"id": str(row["member_id"]), "display_name": row["member__display_name"]}
            )
        # Workspace admins can add themselves to any project, secret ones too (brief: Privacy), so a list
        # is only as private as the number of admins outside its project.
        admins = set(
            WorkspaceMember.objects.filter(workspace=workspace, is_active=True, role=20).values_list(
                "member_id", flat=True
            )
        )
        lists = (
            visible_lists(request.user, workspace.pk)
            .annotate(item_count=Count("items", filter=Q(items__deleted_at__isnull=True)))
            .order_by("project__name", "sort_order", "created_at")
        )
        return Response(
            {
                "me": {"id": str(request.user.pk), "display_name": request.user.display_name},
                "projects": [
                    {
                        "id": str(p.pk),
                        "name": p.name,
                        "identifier": p.identifier,
                        "network": p.network,
                        "members": members.get(p.pk, []),
                        "admins_outside": len(admins - {uuid.UUID(m["id"]) for m in members.get(p.pk, [])}),
                    }
                    for p in projects
                ],
                "lists": [
                    {
                        "id": str(lst.pk),
                        "name": lst.name,
                        "project": str(lst.project_id),
                        "default_mode": lst.default_mode,
                        "sort_order": lst.sort_order,
                        "item_count": lst.item_count,
                    }
                    for lst in lists
                ],
            }
        )


class InventoryPreferenceEndpoint(InventoryBaseView):
    def _payload(self, pref):
        return {"category_order": pref.category_order, "default_grouping": pref.default_grouping}

    def get(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        pref = InventoryPreference.objects.filter(workspace=workspace, user=request.user).first()
        return Response(self._payload(pref) if pref else {"category_order": [], "default_grouping": "category"})

    def put(self, request, slug):
        workspace = self._workspace(slug)
        if workspace is None or not is_inventory_member(request.user, workspace.pk):
            return _forbidden()
        order = request.data.get("category_order", [])
        grouping = request.data.get("default_grouping", "category")
        if (
            not isinstance(order, list)
            or len(order) > 200
            or not all(isinstance(c, str) and len(c) <= 255 for c in order)
        ):
            return _bad("category_order")
        if grouping not in GROUPINGS:
            return _bad("default_grouping")
        pref, _ = InventoryPreference.objects.get_or_create(workspace=workspace, user=request.user)
        pref.category_order, pref.default_grouping = order, grouping
        pref.save(update_fields=["category_order", "default_grouping", "updated_at"])
        return Response(self._payload(pref))


# ---------------------------------------------------------------- project level


def _clean_item_data(data, current=None):
    """Validate data fields (never state). Returns (cleaned, error_response)."""
    if not isinstance(data, dict):
        return None, _bad("body")
    forbidden = sorted(ITEM_STATE_FIELDS & set(data))
    if forbidden:
        return None, _bad(forbidden[0], "state is changed by operations, not by editing the item")
    cleaned = {}
    for field in ITEM_DATA_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if field == "name":
            if not isinstance(value, str) or not value.strip() or len(value) > 255:
                return None, _bad(field)
            value = " ".join(value.split())
        elif field in ("category", "store", "variant", "barcode", "currency"):
            limit = {"barcode": 64, "currency": 3}.get(field, 255)
            if not isinstance(value, str) or len(value) > limit:
                return None, _bad(field)
            value = value.strip()
        elif field == "purchase_url":
            if (
                not isinstance(value, str)
                or len(value) > 2048
                or (value and not value.startswith(("https://", "http://")))
            ):
                return None, _bad(field)
        elif field == "buy_online":
            if not isinstance(value, bool):
                return None, _bad(field)
        elif field in ("min_quantity", "restock_to"):
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > engine.MAX_QUANTITY
            ):
                return None, _bad(field)
        elif field == "sort_order":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None, _bad(field)
        elif field == "last_price":
            if value is not None:
                try:
                    value = Decimal(str(value))
                except InvalidOperation:
                    return None, _bad(field)
                if value < 0 or value >= Decimal("1e10"):
                    return None, _bad(field)
        elif field == "expires_on":
            if value is not None:
                try:
                    value = date.fromisoformat(value)
                except (TypeError, ValueError):
                    return None, _bad(field)
        elif field in ("external_source", "external_id"):
            # NULL, never "": two empty strings would collide on the re-run key (brief, Moving an item).
            if value == "":
                value = None
            if value is not None and (not isinstance(value, str) or len(value) > 255):
                return None, _bad(field)
        cleaned[field] = value
    # min_quantity and restock_to are validated as a pair against what the item already holds.
    minimum = cleaned.get("min_quantity", current.min_quantity if current else None)
    restock = cleaned.get("restock_to", current.restock_to if current else None)
    if restock is not None and (minimum is None or restock < minimum):
        return None, _bad("restock_to", "restock_to must be empty or at least min_quantity")
    return cleaned, None


class ProjectInventoryBaseView(InventoryBaseView):
    def _project(self, request, slug, project_id):
        """The project when the requester may use its inventory, else None (answered 403)."""
        project = Project.objects.filter(pk=project_id, workspace__slug=slug).first()
        if project is None or not can_use_project(request.user, project):
            return None
        return project


class ProjectInventoryListsEndpoint(ProjectInventoryBaseView):
    def get(self, request, slug, project_id):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        lists = InventoryList.objects.filter(project=project).order_by("sort_order", "created_at")
        return Response(
            [
                {"id": str(lst.pk), "name": lst.name, "default_mode": lst.default_mode, "sort_order": lst.sort_order}
                for lst in lists
            ]
        )

    def post(self, request, slug, project_id):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        name = request.data.get("name")
        mode = request.data.get("default_mode", InventoryMode.ON_DEMAND)
        if not isinstance(name, str) or not name.strip() or len(name) > 255:
            return _bad("name")
        if mode not in InventoryMode.values:
            return _bad("default_mode")
        lst = InventoryList.objects.create(project=project, name=" ".join(name.split()), default_mode=mode)
        return Response(
            {"id": str(lst.pk), "name": lst.name, "default_mode": lst.default_mode, "sort_order": lst.sort_order},
            status=status.HTTP_201_CREATED,
        )


class ProjectInventoryListDetailEndpoint(ProjectInventoryBaseView):
    def patch(self, request, slug, project_id, pk):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        lst = InventoryList.objects.filter(pk=pk, project=project).first()
        if lst is None:
            return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
        if "name" in request.data:
            name = request.data["name"]
            if not isinstance(name, str) or not name.strip() or len(name) > 255:
                return _bad("name")
            lst.name = " ".join(name.split())
        if "default_mode" in request.data:
            if request.data["default_mode"] not in InventoryMode.values:
                return _bad("default_mode")
            lst.default_mode = request.data["default_mode"]
        if "sort_order" in request.data:
            if isinstance(request.data["sort_order"], bool) or not isinstance(request.data["sort_order"], (int, float)):
                return _bad("sort_order")
            lst.sort_order = request.data["sort_order"]
        lst.save()
        return Response(
            {"id": str(lst.pk), "name": lst.name, "default_mode": lst.default_mode, "sort_order": lst.sort_order}
        )

    def delete(self, request, slug, project_id, pk):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        lst = InventoryList.objects.filter(pk=pk, project=project).first()
        if lst is None:
            return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
        lst.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectInventoryItemsEndpoint(ProjectInventoryBaseView):
    def get(self, request, slug, project_id, list_id):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        lst = InventoryList.objects.filter(pk=list_id, project=project).first()
        if lst is None:
            return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
        items = with_orders(InventoryItem.objects.filter(inventory_list=lst)).order_by("sort_order", "name_normalised")
        now = timezone.now()
        orders = InventoryOrder.objects.filter(
            item__inventory_list=lst, status=InventoryOrderStatus.OPEN
        ).select_related("item")
        return Response(
            {
                "items": [item_payload(i, i.on_order, i.open_count > 0) for i in items],
                "open_orders": [order_payload(o, now) for o in orders],
            }
        )

    def post(self, request, slug, project_id, list_id):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        lst = InventoryList.objects.filter(pk=list_id, project=project).first()
        if lst is None:
            return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
        data = dict(request.data) if isinstance(request.data, dict) else None
        mode = data.pop("mode", lst.default_mode) if data is not None else None
        if mode not in InventoryMode.values:
            return _bad("mode")
        if mode == InventoryMode.UNITS and data.get("min_quantity") is None:
            data["min_quantity"] = 1  # a new units item gets a minimum of 1 (brief)
        cleaned, error = _clean_item_data(data)
        if error is not None:
            return error
        if "name" not in cleaned:
            return _bad("name")
        existing = InventoryItem.objects.filter(
            inventory_list=lst, name_normalised=normalise_item_name(cleaned["name"])
        ).first()
        if existing is not None:
            existing = with_orders(InventoryItem.objects.filter(pk=existing.pk)).get()
            return Response(
                {"error": "exists", "item": item_payload(existing, existing.on_order, existing.open_count > 0)},
                status=status.HTTP_409_CONFLICT,
            )
        # A new item goes onto the to-buy list at once (brief, Item state).
        now = timezone.now()
        state = {"mode": mode}
        if mode == InventoryMode.ON_DEMAND:
            state.update(needed=True, needed_by=request.user, needed_at=now)
        elif mode == InventoryMode.LEVEL:
            state["level"] = InventoryLevel.LOW
        elif mode == InventoryMode.UNITS:
            state["quantity"] = 0
        try:
            with transaction.atomic():
                item = InventoryItem.objects.create(project=project, inventory_list=lst, **cleaned, **state)
        except IntegrityError:
            return Response({"error": "exists"}, status=status.HTTP_409_CONFLICT)
        item = with_orders(InventoryItem.objects.filter(pk=item.pk)).get()
        return Response(item_payload(item), status=status.HTTP_201_CREATED)


class ProjectInventoryItemDetailEndpoint(ProjectInventoryBaseView):
    def patch(self, request, slug, project_id, pk):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        if not isinstance(request.data, dict):
            return _bad("body")
        data = dict(request.data)
        target_list_id = data.pop("inventory_list", None)
        target = None
        if target_list_id is not None:
            # The target must be a list the requester may use, in any project of this workspace.
            target = visible_lists(request.user, project.workspace_id).filter(pk=target_list_id).first()
            if target is None:
                return _forbidden()
        try:
            with transaction.atomic():
                # The item and its data are read and checked under the item's row lock: an unlocked read
                # could save back a project or list someone changed in between (phase 2 audit). of=self:
                # the list join must not be locked, or two opposite moves deadlock (phase 2 re-review).
                locked = (
                    InventoryItem.objects.select_for_update(of=("self",))
                    .filter(pk=pk, project=project, inventory_list__deleted_at__isnull=True)
                    .first()
                )
                if locked is None:
                    return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
                cleaned, error = _clean_item_data(data, current=locked)
                if error is not None:
                    return error
                for field, value in cleaned.items():
                    setattr(locked, field, value)
                if target is not None and target.pk != locked.inventory_list_id:
                    # The target was checked before the lock; re-check it is still usable now.
                    target = (
                        visible_lists(request.user, project.workspace_id)
                        .select_related("project")
                        .filter(pk=target.pk)
                        .first()
                    )
                    if target is None:
                        return _forbidden()
                    if target.project_id != locked.project_id:
                        # Orders and events are CASCADE copies of the project: they move with the item, or
                        # the old project's deletion would take them. update() skips save(), so both are set.
                        locked.project = target.project
                        InventoryOrder.all_objects.filter(item=locked).update(
                            project_id=target.project_id, workspace_id=target.workspace_id
                        )
                        InventoryEvent.objects.filter(item=locked).update(
                            project_id=target.project_id, workspace_id=target.workspace_id
                        )
                    locked.inventory_list = target
                # Data edits do not advance state_rev (brief).
                locked.save()
        except IntegrityError:
            return Response({"error": "exists"}, status=status.HTTP_409_CONFLICT)
        locked = with_orders(InventoryItem.objects.filter(pk=locked.pk)).get()
        return Response(item_payload(locked, locked.on_order, locked.open_count > 0))

    def delete(self, request, slug, project_id, pk):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        with transaction.atomic():
            # Soft-deleted here rather than with item.delete(): that is a full save() and enqueues the
            # cascade before the commit, where a fast worker reads the old row. Under the lock, then the
            # cascade on commit (phase 2 re-review).
            item = InventoryItem.objects.select_for_update(of=("self",)).filter(pk=pk, project=project).first()
            if item is None:
                return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
            item.deleted_at = timezone.now()
            item.save(update_fields=["deleted_at", "updated_at", "updated_by"])
            item_pk = item.pk
            transaction.on_commit(lambda: soft_delete_related_objects.delay("db", "inventoryitem", item_pk))
        return Response(status=status.HTTP_204_NO_CONTENT)


# Arguments shown in the history; anything else an operation carried stays in the ledger only.
HISTORY_ARGS = ("delta", "quantity", "level", "needed", "pinned", "mode", "order_id", "reference", "reverts")


class ProjectInventoryItemHistoryEndpoint(ProjectInventoryBaseView):
    def get(self, request, slug, project_id, pk):
        project = self._project(request, slug, project_id)
        if project is None:
            return _forbidden()
        if not InventoryItem.objects.filter(pk=pk, project=project, inventory_list__deleted_at__isnull=True).exists():
            return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
        # Applied steps only: a refused operation changed nothing, and the ledger keeps it anyway.
        events = (
            InventoryEvent.objects.filter(item_id=pk, result="applied")
            .select_related("actor")
            .order_by("-received_at")[:50]
        )
        return Response(
            [
                {
                    "id": str(e.pk),
                    "client_op_id": str(e.client_op_id),
                    "op": e.op,
                    "args": {k: e.args[k] for k in HISTORY_ARGS if isinstance(e.args, dict) and k in e.args},
                    "actor": ({"id": str(e.actor_id), "display_name": e.actor.display_name} if e.actor_id else None),
                    "source": e.source,
                    "occurred_at": e.occurred_at.isoformat(),
                    "received_at": e.received_at.isoformat(),
                    "reverted": e.reverted_at is not None,
                }
                for e in events
            ]
        )
