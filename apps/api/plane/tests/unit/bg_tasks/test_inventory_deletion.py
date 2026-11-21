# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every way a workspace or project leaves the database also takes its inventory rows (APLANE-59).

The three paths that matter, each measured against the deploy gate in phase 0 (M6): the nightly
purge, the QA seed's reset (`Workspace.all_objects.filter(...).delete()`, a real delete), and the
soft-delete cascade. Every FK is DEFERRABLE INITIALLY DEFERRED, so a dangling row would only fail
at COMMIT, which a test inside pytest-django's transaction never reaches: each test forces the
check with SET CONSTRAINTS ALL IMMEDIATE."""

import uuid
from unittest.mock import patch

import pytest
from django.db import connection
from django.utils import timezone

from plane.bgtasks.deletion_task import hard_delete, soft_delete_related_objects
from plane.db.models import (
    FileAsset,
    InventoryEvent,
    InventoryItem,
    InventoryList,
    InventoryOrder,
    InventoryPreference,
    Project,
    Workspace,
)

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

INVENTORY = (InventoryList, InventoryItem, InventoryOrder, InventoryPreference)


@pytest.fixture(autouse=True)
def storage():
    with patch("plane.settings.storage.S3Storage") as mocked:
        mocked.return_value.delete_files.return_value = True
        yield mocked.return_value


@pytest.fixture
def stocked(workspace, create_user):
    """A project with one row of every inventory table."""
    project = Project.objects.create(name="Home", identifier="HOME", workspace=workspace)
    lst = InventoryList.objects.create(name="Supermarket", project=project)
    item = InventoryItem.objects.create(name="Milk", inventory_list=lst, project=project, needed=True)
    order = InventoryOrder.objects.create(item=item, project=project, ordered_at=timezone.now(), ordered_by=create_user)
    InventoryPreference.objects.create(workspace=workspace, user=create_user)
    InventoryEvent.objects.create(
        client_op_id=uuid.uuid4(),
        workspace=workspace,
        project=project,
        item=item,
        order=order,
        actor=create_user,
        op="mark_ordered",
        result="applied",
        occurred_at=timezone.now(),
    )
    return project


def _constraints_hold():
    with connection.cursor() as cur:
        cur.execute("SET CONSTRAINTS ALL IMMEDIATE")


def _left(workspace_id):
    counts = {m.__name__: m.all_objects.filter(workspace_id=workspace_id).count() for m in INVENTORY}
    counts["InventoryEvent"] = InventoryEvent.objects.filter(workspace_id=workspace_id).count()
    return counts


def test_the_qa_seed_reset_deletes_a_workspace_holding_inventory_rows(stocked):
    workspace_id = stocked.workspace_id
    Workspace.all_objects.filter(pk=workspace_id).delete()
    _constraints_hold()
    assert set(_left(workspace_id).values()) == {0}


def test_the_purge_takes_a_long_deleted_workspace_with_its_inventory(
    stocked, settings, django_capture_on_commit_callbacks
):
    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60
    workspace_id = stocked.workspace_id
    Workspace.all_objects.filter(pk=workspace_id).update(deleted_at=timezone.now() - timezone.timedelta(days=61))
    with django_capture_on_commit_callbacks(execute=True):
        hard_delete()
    _constraints_hold()
    assert not Workspace.all_objects.filter(pk=workspace_id).exists()
    assert set(_left(workspace_id).values()) == {0}


def test_the_purge_takes_a_long_deleted_project_and_leaves_the_workspace_rows(
    stocked, settings, django_capture_on_commit_callbacks
):
    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60
    Project.all_objects.filter(pk=stocked.pk).update(deleted_at=timezone.now() - timezone.timedelta(days=61))
    with django_capture_on_commit_callbacks(execute=True):
        hard_delete()
    _constraints_hold()
    left = _left(stocked.workspace_id)
    assert left["InventoryList"] == left["InventoryItem"] == left["InventoryOrder"] == left["InventoryEvent"] == 0
    assert left["InventoryPreference"] == 1, "a preference belongs to the workspace, not the project"


def test_soft_deleting_a_project_soft_deletes_its_lists_items_and_orders_and_skips_events(stocked):
    stocked.deleted_at = timezone.now()
    stocked.save()
    soft_delete_related_objects("db", "project", stocked.pk)
    for model in (InventoryList, InventoryItem, InventoryOrder):
        assert model.objects.filter(project=stocked).count() == 0, model.__name__
        assert model.all_objects.filter(project=stocked).count() == 1, model.__name__
    assert InventoryEvent.objects.filter(project=stocked).count() == 1


def test_soft_deleting_a_workspace_soft_deletes_its_inventory(stocked):
    workspace = stocked.workspace
    workspace.deleted_at = timezone.now()
    workspace.save()
    soft_delete_related_objects("db", "workspace", workspace.pk)
    for model in (InventoryList, InventoryItem, InventoryOrder):
        assert model.objects.filter(workspace=workspace).count() == 0, model.__name__
        assert model.all_objects.filter(workspace=workspace).count() == 1, model.__name__
    assert InventoryEvent.objects.filter(workspace=workspace).count() == 1


def test_purging_a_long_deleted_item_of_a_live_list_takes_its_orders_and_events(
    stocked, settings, django_capture_on_commit_callbacks
):
    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60
    InventoryItem.all_objects.filter(project=stocked).update(deleted_at=timezone.now() - timezone.timedelta(days=61))
    with django_capture_on_commit_callbacks(execute=True):
        hard_delete()
    _constraints_hold()
    left = _left(stocked.workspace_id)
    assert left["InventoryItem"] == left["InventoryOrder"] == left["InventoryEvent"] == 0
    assert left["InventoryList"] == 1


def _photo(item, key):
    return FileAsset.objects.create(
        asset=key,
        workspace_id=item.workspace_id,
        project_id=item.project_id,
        inventory_item=item,
        entity_type="INVENTORY_ITEM_PHOTO",
        is_uploaded=True,
        size=1024,
    )


def test_soft_deleting_an_item_soft_deletes_its_photo(stocked):
    # APLANE-66: the photo hangs off the item by a CASCADE key, so the item's cascade reaches it.
    item = InventoryItem.objects.get(project=stocked)
    photo = _photo(item, f"{stocked.workspace_id}/photo-soft.jpg")
    item.deleted_at = timezone.now()
    item.save()
    soft_delete_related_objects("db", "inventoryitem", item.pk)
    assert not FileAsset.objects.filter(pk=photo.pk).exists()
    assert FileAsset.all_objects.get(pk=photo.pk).deleted_at is not None


def test_purging_an_item_deletes_its_photo_row_and_stored_object(
    stocked, storage, settings, django_capture_on_commit_callbacks
):
    # The object key exists only in the row: a photo that outlived its row would leak in the bucket.
    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60
    item = InventoryItem.objects.get(project=stocked)
    key = f"{stocked.workspace_id}/photo-purge.jpg"
    photo = _photo(item, key)
    InventoryItem.all_objects.filter(pk=item.pk).update(deleted_at=timezone.now() - timezone.timedelta(days=61))
    with django_capture_on_commit_callbacks(execute=True):
        hard_delete()
    _constraints_hold()
    assert not FileAsset.all_objects.filter(pk=photo.pk).exists()
    storage.delete_files.assert_called_once_with(object_names=[key])
