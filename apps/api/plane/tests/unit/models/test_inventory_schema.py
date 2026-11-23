# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Inventory schema (APLANE-59, phase 1). Shipped dark to prod ahead of the feature, so what these
pin down is what an image without the feature, or a rollback, will meet in the database.

Schema assertions are only honest with `--create-db` (pytest.ini reuses the database)."""

import uuid

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from plane.api.serializers.project import ProjectCreateSerializer
from plane.app.serializers.workspace import WorkSpaceSerializer
from plane.db.models import (
    InventoryEvent,
    InventoryItem,
    InventoryList,
    InventoryOrder,
    InventoryPreference,
    Project,
)
from plane.db.models.inventory import normalise_item_name

pytestmark = [pytest.mark.unit, pytest.mark.django_db]


@pytest.fixture
def project(workspace):
    return Project.objects.create(name="Home", identifier="HOME", workspace=workspace)


@pytest.fixture
def inventory_list(project):
    return InventoryList.objects.create(name="Supermarket", project=project)


def _item(inventory_list, name="Milk", **kwargs):
    return InventoryItem.objects.create(
        name=name, inventory_list=inventory_list, project=inventory_list.project, **kwargs
    )


def _refused(fn):
    """Constraint violations raise at the statement for CHECK and UNIQUE, but every FK is deferred,
    so the savepoint keeps the outer test transaction usable either way."""
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            fn()


def test_the_project_flag_is_off_by_default(project):
    project.refresh_from_db()
    assert project.inventory_view is False


def test_the_flag_column_keeps_a_database_default_for_inserts_that_do_not_name_it():
    """What an image from before this column does after a rollback (M7: with `default=` alone Django
    drops the database default and that INSERT fails with a not-null violation)."""
    with connection.cursor() as cur:
        cur.execute(
            "SELECT column_default FROM information_schema.columns "
            "WHERE table_name = 'projects' AND column_name = 'inventory_view'"
        )
        assert cur.fetchone()[0] == "false"


def test_the_keyword_columns_keep_a_database_default_for_inserts_that_do_not_name_them():
    """Shipped dark (2026-11-23): an image from before 0130 inserts items without naming these columns."""
    with connection.cursor() as cur:
        cur.execute(
            "SELECT column_name, column_default FROM information_schema.columns "
            "WHERE table_name = 'inventory_items' AND column_name IN ('keywords', 'keywords_normalised')"
        )
        defaults = dict(cur.fetchall())
    assert defaults == {"keywords": "''::text", "keywords_normalised": "''::text"}


def test_quantity_is_signed_and_never_clamped(inventory_list):
    item = _item(inventory_list, mode="units", quantity=-3, min_quantity=1)
    item.refresh_from_db()
    assert item.quantity == -3


def test_min_quantity_cannot_be_negative(inventory_list):
    _refused(lambda: _item(inventory_list, mode="units", min_quantity=-1))


def test_restock_to_must_be_empty_or_at_least_the_minimum(inventory_list):
    _item(inventory_list, name="a", mode="units", min_quantity=2, restock_to=2)
    _item(inventory_list, name="b", mode="units", min_quantity=2)
    _refused(lambda: _item(inventory_list, name="c", mode="units", min_quantity=2, restock_to=1))
    _refused(lambda: _item(inventory_list, name="d", mode="units", restock_to=3))


def test_mode_and_level_take_only_known_values(inventory_list):
    _refused(lambda: _item(inventory_list, name="a", mode="weekly"))
    _refused(lambda: _item(inventory_list, name="b", mode="level", level="empty"))
    _item(inventory_list, name="c", mode="level", level="low")


def test_names_are_compared_without_case_or_extra_spaces():
    assert normalise_item_name("  Oat   MILK ") == "oat milk"
    assert normalise_item_name(None) == ""


def test_composed_and_decomposed_accents_are_one_name():
    assert normalise_item_name("Caf\u00e9") == normalise_item_name("Cafe\u0301") == "caf\u00e9"


def test_a_name_that_casefolds_longer_than_255_is_stored(inventory_list):
    item = _item(inventory_list, name="\u00df" * 255)
    item.refresh_from_db()
    assert len(item.name_normalised) == 510


def test_the_seed_import_key_is_unique_per_project_among_live_items(inventory_list, project):
    first = _item(inventory_list, name="a", external_source="seed", external_id="milk")
    _refused(lambda: _item(inventory_list, name="b", external_source="seed", external_id="milk"))
    _item(inventory_list, name="c")
    _item(inventory_list, name="d")
    InventoryItem.all_objects.filter(pk=first.pk).update(deleted_at=timezone.now())
    _item(inventory_list, name="e", external_source="seed", external_id="milk")
    other_project = Project.objects.create(name="Office", identifier="OFF", workspace=project.workspace)
    other_list = InventoryList.objects.create(name="Kitchen", project=other_project)
    _item(other_list, name="f", external_source="seed", external_id="milk")


def test_an_order_can_record_a_purchase_made_while_it_was_open(inventory_list, create_user):
    item = _item(inventory_list)
    order = InventoryOrder.objects.create(item=item, project=item.project, ordered_at=timezone.now())
    order.bought_since_at = timezone.now()
    order.bought_since_by = create_user
    order.save()
    order.refresh_from_db()
    assert order.bought_since_at is not None and order.bought_since_by_id == create_user.id


def test_every_user_foreign_key_is_set_null():
    """Removing a user must never remove inventory history or orders with them."""
    from django.conf import settings

    for model in (InventoryItem, InventoryOrder, InventoryEvent):
        for field in model._meta.concrete_fields:
            if field.is_relation and field.related_model._meta.label == settings.AUTH_USER_MODEL:
                assert field.remote_field.on_delete.__name__ == "SET_NULL", (model.__name__, field.name)


def test_a_list_holds_one_live_item_per_name(inventory_list, project):
    first = _item(inventory_list, name="Oat milk")
    _refused(lambda: _item(inventory_list, name="  oat  MILK"))
    other = InventoryList.objects.create(name="Pharmacy", project=project)
    _item(other, name="Oat milk")
    InventoryItem.all_objects.filter(pk=first.pk).update(deleted_at=timezone.now())
    _item(inventory_list, name="oat milk")


def test_renaming_with_update_fields_keeps_the_normalised_name_in_step(inventory_list):
    item = _item(inventory_list, name="Milk")
    item.name = "Whole  MILK"
    item.save(update_fields=["name"])
    item.refresh_from_db()
    assert item.name_normalised == "whole milk"


def test_keywords_are_normalised_like_names_also_with_update_fields(inventory_list):
    item = _item(inventory_list, name="Masło")
    item.keywords = "Butter  ŁADNE"
    item.save(update_fields=["keywords"])
    item.refresh_from_db()
    assert item.keywords_normalised == "butter ładne"
    item.name = "Mantequilla / Masło"
    item.save(update_fields=["name"])
    item.refresh_from_db()
    assert (item.name_normalised, item.keywords_normalised) == ("mantequilla / masło", "butter ładne")


def test_an_order_needs_a_positive_quantity_and_takes_the_device_id(inventory_list):
    item = _item(inventory_list)
    device_id = uuid.uuid4()
    order = InventoryOrder.objects.create(
        id=device_id, item=item, project=item.project, quantity=2, ordered_at=timezone.now()
    )
    assert order.pk == device_id and order.status == "open" and order.source == "web"
    _refused(
        lambda: InventoryOrder.objects.create(item=item, project=item.project, quantity=0, ordered_at=timezone.now())
    )
    _refused(
        lambda: InventoryOrder.objects.create(item=item, project=item.project, status="lost", ordered_at=timezone.now())
    )


def test_client_op_id_is_unique_on_its_own(inventory_list, workspace):
    op = uuid.uuid4()
    kwargs = {"workspace": workspace, "op": "buy", "result": "applied", "occurred_at": timezone.now()}
    InventoryEvent.objects.create(client_op_id=op, **kwargs)
    _refused(lambda: InventoryEvent.objects.create(client_op_id=op, **kwargs))
    _refused(lambda: InventoryEvent.objects.create(client_op_id=uuid.uuid4(), **{**kwargs, "result": "ok"}))


def test_one_live_preference_row_per_user_and_workspace(workspace, create_user):
    InventoryPreference.objects.create(workspace=workspace, user=create_user)
    _refused(lambda: InventoryPreference.objects.create(workspace=workspace, user=create_user))


def test_the_event_table_has_no_soft_delete_and_nothing_points_at_it():
    assert not hasattr(InventoryEvent, "deleted_at")
    visible_reverse = [
        f for f in InventoryEvent._meta.get_fields() if (f.one_to_many or f.one_to_one) and f.auto_created
    ]
    assert visible_reverse == []
    for name in ("workspace", "project", "item", "order", "actor"):
        assert InventoryEvent._meta.get_field(name).remote_field.related_name == "+"


def test_no_inventory_foreign_key_is_do_nothing_or_protect():
    """The hard-delete task dies on DO_NOTHING (APLANE-40); PROTECT would block every purge."""
    for model in (InventoryList, InventoryItem, InventoryOrder, InventoryPreference, InventoryEvent):
        for field in model._meta.concrete_fields:
            if field.is_relation:
                assert field.remote_field.on_delete.__name__ in ("CASCADE", "SET_NULL"), (model, field.name)


def test_shopping_is_a_reserved_workspace_slug():
    serializer = WorkSpaceSerializer(data={"name": "Shopping", "slug": "shopping"})
    assert not serializer.is_valid()
    assert "slug" in serializer.errors


def test_the_external_api_accepts_the_flag():
    assert "inventory_view" in ProjectCreateSerializer.Meta.fields
