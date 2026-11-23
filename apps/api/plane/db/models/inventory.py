# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Inventory and shopping lists (APLANE-57). Design: docs/INVENTORY_DESIGN.md.
#
# Schema constraints a future session must keep:
# - Every FK is CASCADE (parents) or SET_NULL (users). Never DO_NOTHING or PROTECT: Django performs
#   cascades itself, and the hard-delete task dies on a DO_NOTHING (APLANE-40).
# - InventoryEvent is a plain model with no deleted_at, and every FK it holds is hidden
#   (related_name="+"): soft_delete_related_objects walks visible reverse relations and loads each row,
#   while Django's Collector still cascades through hidden ones on a hard delete (measured in M6).
# - name_normalised and keywords_normalised are computed in save() only: update(), bulk_create() and
#   bulk_update() skip them, so anything that writes names or keywords in bulk must set them with
#   normalise_item_name.
# - Moving an item to another project must rewrite `project` and `workspace` on its orders and events
#   in the same transaction: both are CASCADE copies, and the old project's deletion would take them.
#   update() skips ProjectBaseModel.save(), which is what keeps `workspace` in step.
# - `quantity` is signed and has no CHECK: clamping would make the result depend on delivery order.
# - Shipped dark to prod ahead of the feature (plan, phase 1). Any later change to these tables ships
#   the same way, and a column added to an existing table carries db_default (M7).

import unicodedata
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

from .base import BaseModel
from .project import ProjectBaseModel


class InventoryMode(models.TextChoices):
    PINNED = "pinned", "Pinned"
    ON_DEMAND = "on_demand", "On demand"
    LEVEL = "level", "Level"
    UNITS = "units", "Units"


class InventoryLevel(models.TextChoices):
    OK = "ok", "OK"
    LOW = "low", "Low"
    OUT = "out", "Out"


class InventoryOrderStatus(models.TextChoices):
    OPEN = "open", "Open"
    RECEIVED = "received", "Received"
    CANCELLED = "cancelled", "Cancelled"


class InventorySource(models.TextChoices):
    WEB = "web", "Web"
    API = "api", "API"


def normalise_item_name(name):
    # "Compared without case or extra spaces" (brief, Item state). NFKC first, so a composed and a
    # decomposed accent are one name. casefold() can lengthen a string ("ß" → "ss"), hence a text column.
    return " ".join(unicodedata.normalize("NFKC", name or "").split()).casefold()


def fold_for_search(text):
    """normalise_item_name without accents, for the keyword search: "jabón" finds a keyword written "jabon". Only
    combining marks go, so Polish ł (a letter of its own, not l + a mark) stays: keyword lists carry "l" spellings
    where wanted. Never used for names: their uniqueness keeps accents."""
    decomposed = unicodedata.normalize("NFKD", normalise_item_name(text))
    return unicodedata.normalize("NFC", "".join(ch for ch in decomposed if not unicodedata.combining(ch)))


def search_text(name, keywords):
    """What the search matches, accent-free: the name on the first line, the keywords after it, so "platano" finds
    "Plátano" by its name too (re-review). No line break survives the fold, so a query never spans the two."""
    return fold_for_search(name) + "\n" + fold_for_search(keywords)


class InventoryList(ProjectBaseModel):
    name = models.CharField(max_length=255)
    default_mode = models.CharField(max_length=16, choices=InventoryMode.choices, default=InventoryMode.ON_DEMAND)
    sort_order = models.FloatField(default=65535)

    class Meta:
        verbose_name = "Inventory List"
        verbose_name_plural = "Inventory Lists"
        db_table = "inventory_lists"
        ordering = ("sort_order", "created_at")
        constraints = [
            models.CheckConstraint(
                condition=Q(default_mode__in=InventoryMode.values), name="inventory_list_default_mode_valid"
            ),
        ]

    def __str__(self):
        return self.name


class InventoryItem(ProjectBaseModel):
    inventory_list = models.ForeignKey(InventoryList, on_delete=models.CASCADE, related_name="items")
    name = models.CharField(max_length=255)
    name_normalised = models.TextField(editable=False)
    mode = models.CharField(max_length=16, choices=InventoryMode.choices, default=InventoryMode.ON_DEMAND)

    # State. Rule for phase 2: only the operations engine writes these, never the data update endpoint.
    needed = models.BooleanField(default=False)
    needed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    needed_at = models.DateTimeField(null=True, blank=True)
    level = models.CharField(max_length=8, choices=InventoryLevel.choices, null=True, blank=True)
    quantity = models.IntegerField(null=True, blank=True)
    last_bought_at = models.DateTimeField(null=True, blank=True)
    last_bought_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    state_rev = models.PositiveBigIntegerField(default=0)

    # Data. Rule for phase 2: edited online through the item update endpoint, which does not advance
    # state_rev. Of the `units` fields a mode change clears only `quantity`: min_quantity and restock_to
    # are data and stay, so the restock CHECK below never fires on a mode change (the update endpoint
    # validates the pair). Writers with no external id write NULL, never "" ("" pairs collide).
    min_quantity = models.IntegerField(null=True, blank=True)
    restock_to = models.IntegerField(null=True, blank=True)
    category = models.CharField(max_length=255, blank=True, default="")
    store = models.CharField(max_length=255, blank=True, default="")
    buy_online = models.BooleanField(default=False)
    purchase_url = models.TextField(blank=True, default="")
    variant = models.CharField(max_length=255, blank=True, default="")
    last_price = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, blank=True, default="")
    expires_on = models.DateField(null=True, blank=True)
    barcode = models.CharField(max_length=64, blank=True, default="")
    # Other names to find the item by (owner, 2026-11-23: names in Spanish and Polish, English and synonyms
    # here). keywords_normalised is the SEARCH text, computed in save(): the folded name, a line break, the folded
    # keywords (search_text: casefold + no accents, in Python, not the database's lower(), whose behaviour on Ł/ł
    # depends on the collation). It depends on both fields; 0131 filled it for the rows from before.
    keywords = models.TextField(blank=True, default="", db_default="")
    keywords_normalised = models.TextField(editable=False, default="", db_default="")
    sort_order = models.FloatField(default=65535)
    external_source = models.CharField(max_length=255, null=True, blank=True)
    external_id = models.CharField(max_length=255, null=True, blank=True)

    class Meta:
        verbose_name = "Inventory Item"
        verbose_name_plural = "Inventory Items"
        db_table = "inventory_items"
        ordering = ("sort_order", "created_at")
        constraints = [
            models.CheckConstraint(condition=Q(mode__in=InventoryMode.values), name="inventory_item_mode_valid"),
            models.CheckConstraint(
                condition=Q(level__isnull=True) | Q(level__in=InventoryLevel.values),
                name="inventory_item_level_valid",
            ),
            models.CheckConstraint(
                condition=Q(min_quantity__isnull=True) | Q(min_quantity__gte=0),
                name="inventory_item_min_quantity_not_negative",
            ),
            models.CheckConstraint(
                condition=Q(restock_to__isnull=True)
                | (Q(min_quantity__isnull=False) & Q(restock_to__gte=models.F("min_quantity"))),
                name="inventory_item_restock_to_at_least_min",
            ),
            models.UniqueConstraint(
                fields=["inventory_list", "name_normalised"],
                condition=Q(deleted_at__isnull=True),
                name="inventory_item_unique_live_name_per_list",
            ),
            # So the seed import can be re-run (brief, Proposed model).
            models.UniqueConstraint(
                fields=["project", "external_source", "external_id"],
                condition=Q(deleted_at__isnull=True, external_source__isnull=False, external_id__isnull=False),
                name="inventory_item_unique_live_external_id",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "project"], name="inv_item_ws_project_idx"),
        ]

    def save(self, *args, **kwargs):
        self.name_normalised = normalise_item_name(self.name)
        self.keywords_normalised = search_text(self.name, self.keywords)
        update_fields = kwargs.get("update_fields")
        if update_fields is not None:
            derived_from = {"name": ("name_normalised", "keywords_normalised"), "keywords": ("keywords_normalised",)}
            extra = list(
                dict.fromkeys(d for f in update_fields for d in derived_from.get(f, ()) if d not in update_fields)
            )
            if extra:
                kwargs["update_fields"] = [*update_fields, *extra]
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class InventoryOrder(ProjectBaseModel):
    # The id is made on the device when "ordered" is tapped, so a later arrival or cancel can name it
    # offline (brief, Orders).
    item = models.ForeignKey(InventoryItem, on_delete=models.CASCADE, related_name="orders")
    quantity = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=InventoryOrderStatus.choices, default=InventoryOrderStatus.OPEN)
    received_quantity = models.PositiveIntegerField(null=True, blank=True)
    source = models.CharField(max_length=8, choices=InventorySource.choices, default=InventorySource.WEB)
    reference = models.CharField(max_length=255, blank=True, default="")
    expected_on = models.DateField(null=True, blank=True)
    ordered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    ordered_at = models.DateTimeField()
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    received_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)
    # Set by the engine when a purchase is applied to the item while this order is open (brief, Orders:
    # "bought since it was ordered"). Not derived from last_bought_at: that is the purchase's own time,
    # which can predate the order when the purchase was made offline (S64), and events are pruned.
    bought_since_at = models.DateTimeField(null=True, blank=True)
    bought_since_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        verbose_name = "Inventory Order"
        verbose_name_plural = "Inventory Orders"
        db_table = "inventory_orders"
        ordering = ("-ordered_at",)
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=InventoryOrderStatus.values), name="inventory_order_status_valid"
            ),
            models.CheckConstraint(condition=Q(quantity__gte=1), name="inventory_order_quantity_positive"),
            models.CheckConstraint(condition=Q(source__in=InventorySource.values), name="inventory_order_source_valid"),
        ]
        indexes = [
            models.Index(fields=["item", "status"], name="inv_order_item_status_idx"),
        ]

    def __str__(self):
        return f"{self.item_id} {self.status}"


class InventoryPreference(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    category_order = models.JSONField(default=list)
    default_grouping = models.CharField(max_length=16, default="category")

    class Meta:
        verbose_name = "Inventory Preference"
        verbose_name_plural = "Inventory Preferences"
        db_table = "inventory_preferences"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "user"],
                condition=Q(deleted_at__isnull=True),
                name="inventory_preference_unique_live_per_user",
            ),
        ]

    def __str__(self):
        return f"{self.workspace_id} {self.user_id}"


class InventoryEvent(models.Model):
    # History, idempotency ledger and revert record in one row per received operation. Plain model:
    # no soft delete, nothing points at it. Rules for phase 2: pruned after 90 days; written in the
    # same transaction as the state change it records (the unique client_op_id then rolls back a racing
    # duplicate); a duplicate lookup compares actor and target too, since client_op_id is global.
    id = models.UUIDField(default=uuid.uuid4, primary_key=True, editable=False)
    client_op_id = models.UUIDField(unique=True)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE, null=True, blank=True, related_name="+")
    item = models.ForeignKey(InventoryItem, on_delete=models.CASCADE, null=True, blank=True, related_name="+")
    order = models.ForeignKey(InventoryOrder, on_delete=models.CASCADE, null=True, blank=True, related_name="+")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+")
    queue_id = models.UUIDField(null=True, blank=True)
    op = models.CharField(max_length=32)
    version = models.PositiveSmallIntegerField(default=1)
    args = models.JSONField(default=dict)
    base_rev = models.PositiveBigIntegerField(null=True, blank=True)
    result = models.CharField(max_length=16)
    reason = models.CharField(max_length=32, blank=True, default="")
    previous = models.JSONField(null=True, blank=True)
    resulting_rev = models.PositiveBigIntegerField(null=True, blank=True)
    reverted_at = models.DateTimeField(null=True, blank=True)
    source = models.CharField(max_length=8, choices=InventorySource.choices, default=InventorySource.WEB)
    occurred_at = models.DateTimeField()
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Inventory Event"
        verbose_name_plural = "Inventory Events"
        db_table = "inventory_events"
        constraints = [
            models.CheckConstraint(
                condition=Q(result__in=["applied", "stale", "rejected"]), name="inventory_event_result_valid"
            ),
        ]
        indexes = [
            models.Index(fields=["item", "-received_at"], name="inv_event_item_idx"),
            models.Index(fields=["workspace", "received_at"], name="inv_event_ws_received_idx"),
        ]

    def __str__(self):
        return f"{self.op} {self.result}"
