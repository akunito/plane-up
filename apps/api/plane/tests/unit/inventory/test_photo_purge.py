# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# The daily purge of removed inventory photos (owner, 2026-11-22: removed photos must really go, ~14 days).

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from plane.bgtasks.inventory_task import purge_removed_inventory_photos
from plane.db.models import FileAsset


@pytest.fixture
def storage():
    # Patched where the sweep imports it lazily (deletion_task._delete_blobs), as the hard_delete tests do.
    with patch("plane.settings.storage.S3Storage") as mocked:
        mocked.return_value.delete_files.return_value = True
        yield mocked.return_value


@pytest.fixture
def purge(django_capture_on_commit_callbacks):
    def _run():
        with django_capture_on_commit_callbacks(execute=True):
            return purge_removed_inventory_photos()

    return _run


def _photo(item, key, *, uploaded=True, deleted_days=None, created_days=0):
    asset = FileAsset.objects.create(
        workspace=item.project.workspace,
        project=item.project,
        inventory_item=item,
        entity_type=FileAsset.INVENTORY_ITEM_PHOTO,
        asset=key,
        size=1000,
        attributes={"name": "photo.jpg", "type": "image/jpeg", "size": 1000},
        is_uploaded=uploaded,
    )
    now = timezone.now()
    fields = {"created_at": now - timedelta(days=created_days)}
    if deleted_days is not None:
        fields.update(deleted_at=now - timedelta(days=deleted_days), is_deleted=True)
    FileAsset.all_objects.filter(pk=asset.pk).update(**fields)
    return asset


def _deleted_keys(storage):
    return sorted(k for call in storage.delete_files.call_args_list for k in call.kwargs["object_names"])


def test_removed_and_abandoned_photos_go_after_14_days_and_nothing_else(db, make_item, storage, purge):
    item = make_item("Milk")
    live = _photo(item, "ws/live.jpg", created_days=40)
    removed_old = _photo(item, "ws/removed-old.jpg", created_days=40, deleted_days=15)
    removed_new = _photo(item, "ws/removed-new.jpg", created_days=40, deleted_days=5)
    pending_old = _photo(item, "ws/pending-old.jpg", uploaded=False, created_days=15)
    pending_new = _photo(item, "ws/pending-new.jpg", uploaded=False, created_days=1)
    # Not a photo: the general purge's business (disarmed in prod), never this task's.
    other = FileAsset.objects.create(
        workspace=item.project.workspace, project=item.project, asset="ws/cover.png", size=5, attributes={}
    )
    FileAsset.all_objects.filter(pk=other.pk).update(deleted_at=timezone.now() - timedelta(days=90))

    assert purge() == 2

    left = set(FileAsset.all_objects.values_list("pk", flat=True))
    assert {live.pk, removed_new.pk, pending_new.pk, other.pk} <= left
    assert not {removed_old.pk, pending_old.pk} & left
    assert _deleted_keys(storage) == ["ws/pending-old.jpg", "ws/removed-old.jpg"]


def test_a_key_another_surviving_row_still_names_is_kept(db, make_item, storage, purge):
    item = make_item("Milk")
    doomed = _photo(item, "ws/shared.jpg", deleted_days=20)
    FileAsset.objects.create(
        workspace=item.project.workspace, project=item.project, asset="ws/shared.jpg", size=5, attributes={}
    )
    assert purge() == 1
    assert not FileAsset.all_objects.filter(pk=doomed.pk).exists()
    assert _deleted_keys(storage) == []


def test_the_photo_of_a_deleted_item_goes_with_the_same_delay(db, make_item, storage, purge):
    item = make_item("Milk")
    photo = _photo(item, "ws/of-deleted-item.jpg", deleted_days=20)
    item.delete()  # soft: the item row stays hidden; its photo row is already past the window
    assert purge() == 1
    assert not FileAsset.all_objects.filter(pk=photo.pk).exists()
    assert _deleted_keys(storage) == ["ws/of-deleted-item.jpg"]


def test_the_window_follows_the_setting(db, make_item, storage, purge, settings):
    settings.INVENTORY_PHOTO_PURGE_DAYS = 30
    item = make_item("Milk")
    kept = _photo(item, "ws/20-days.jpg", deleted_days=20)
    gone = _photo(item, "ws/40-days.jpg", deleted_days=40)
    assert purge() == 1
    assert FileAsset.all_objects.filter(pk=kept.pk).exists()
    assert not FileAsset.all_objects.filter(pk=gone.pk).exists()


def test_a_storage_failure_keeps_the_purge_and_does_not_raise(db, make_item, storage, purge):
    storage.delete_files.side_effect = RuntimeError("endpoint down")
    item = make_item("Milk")
    photo = _photo(item, "ws/x.jpg", deleted_days=20)
    assert purge() == 1
    assert not FileAsset.all_objects.filter(pk=photo.pk).exists()


def test_a_delete_that_removes_nothing_stops_instead_of_looping(db, make_item, storage, purge):
    from django.db.models.query import QuerySet

    item = make_item("Milk")
    _photo(item, "ws/stuck.jpg", deleted_days=20)
    with patch.object(QuerySet, "delete", return_value=(0, {})):
        assert purge() == 0
    storage.delete_files.assert_not_called()


def test_nothing_to_do(db, storage, purge):
    assert purge() == 0
    storage.delete_files.assert_not_called()


def test_it_is_scheduled_daily():
    from plane.celery import app

    entry = app.conf.beat_schedule["check-every-day-to-purge-removed-inventory-photos"]
    assert entry["task"] == "plane.bgtasks.inventory_task.purge_removed_inventory_photos"


def test_the_daily_refresh_rewrites_only_search_text_an_older_fold_left(db, make_item):
    from plane.bgtasks.inventory_task import refresh_inventory_search_text
    from plane.db.models import InventoryItem

    stale = make_item("Masło")
    no_line = make_item("Plátano")
    right = make_item("Milk")
    gone = make_item("Jabłko")
    gone.delete()
    InventoryItem.all_objects.filter(pk=stale.pk).update(keywords_normalised="masło\n")  # the fold before 0132
    InventoryItem.all_objects.filter(pk=no_line.pk).update(keywords_normalised="")  # an image before 0131
    InventoryItem.all_objects.filter(pk=gone.pk).update(keywords_normalised="jabłko\n")
    assert refresh_inventory_search_text() == 3
    texts = dict(InventoryItem.all_objects.values_list("pk", "keywords_normalised"))
    assert (texts[stale.pk], texts[no_line.pk], texts[right.pk], texts[gone.pk]) == (
        "maslo\n",
        "platano\n",
        "milk\n",
        "jablko\n",
    )
    assert refresh_inventory_search_text() == 0  # nothing left to write


def test_the_refresh_is_scheduled_daily():
    from plane.celery import app

    entry = app.conf.beat_schedule["check-every-day-to-refresh-inventory-search-text"]
    assert entry["task"] == "plane.bgtasks.inventory_task.refresh_inventory_search_text"
