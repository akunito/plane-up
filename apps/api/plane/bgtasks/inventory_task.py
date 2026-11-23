# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Event pruning (brief: Ledger). Devices never send an operation older than 60 days, so 90 days of
# ledger is enough to recognise every duplicate delivery. A revert whose event was pruned is answered
# "gone", and a compare-and-set that needs a pruned step counts it as someone else's change.

import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import FileAsset, InventoryEvent, InventoryItem
from plane.db.models.inventory import search_text

logger = logging.getLogger("plane.worker")

KEEP = timedelta(days=90)
CHUNK = 5000


@shared_task
def prune_inventory_events():
    cutoff = timezone.now() - KEEP
    total = 0
    while True:
        ids = list(InventoryEvent.objects.filter(received_at__lt=cutoff).values_list("pk", flat=True)[:CHUNK])
        if not ids:
            break
        deleted, _ = InventoryEvent.objects.filter(pk__in=ids).delete()
        total += deleted
    logger.info("inventory: pruned %s events received before %s", total, cutoff.isoformat())
    return total


PHOTO_CHUNK = 500


@shared_task
def refresh_inventory_search_text():
    """Rewrites every item's search text that differs from search_text(name, keywords) under the CURRENT fold; returns
    how many. A row saved by an older image (deploy window, rollback and back) keeps that image's fold after the
    data migration that refilled the others has run, and nothing else would ever fix it (0132 audit). A household
    has a few hundred items: one pass reads them all; rows already right are not written."""
    stale = []
    for item in InventoryItem.all_objects.only("pk", "name", "keywords", "keywords_normalised").iterator(
        chunk_size=500
    ):
        want = search_text(item.name, item.keywords)
        if item.keywords_normalised != want:
            item.keywords_normalised = want
            stale.append(item)
    for start in range(0, len(stale), 500):
        InventoryItem.all_objects.bulk_update(stale[start : start + 500], ["keywords_normalised"])
    if stale:
        logger.info("inventory search text refreshed for %d items", len(stale))
    return len(stale)


@shared_task
def purge_removed_inventory_photos():
    """Removed or replaced item photos (soft-deleted INVENTORY_ITEM_PHOTO rows) and uploads never confirmed, older
    than INVENTORY_PHOTO_PURGE_DAYS, lose their row and their storage object. Only photo rows: the live photo
    (not deleted, uploaded) is never selected, and a photo of a deleted item goes with the same delay.

    Reuses the general purge's storage sweep (deletion_task._purge_blobs): keys are read before the rows go, the
    objects are deleted only on commit, a key a surviving row still names is kept, and the sweep never raises.
    One transaction per chunk, so a failure keeps what the earlier chunks committed and their objects swept."""
    from plane.bgtasks.deletion_task import _purge_blobs

    cutoff = timezone.now() - timedelta(days=settings.INVENTORY_PHOTO_PURGE_DAYS)
    doomed = FileAsset.all_objects.filter(entity_type=FileAsset.INVENTORY_ITEM_PHOTO).filter(
        Q(deleted_at__lt=cutoff) | Q(deleted_at__isnull=True, is_uploaded=False, created_at__lt=cutoff)
    )
    rows = objects = 0
    while True:
        chunk = list(doomed.values_list("pk", "asset", "size")[:PHOTO_CHUNK])
        if not chunk:
            break
        blobs = [(str(key), int(size or 0)) for _pk, key, size in chunk if key]
        with transaction.atomic():
            # Through `doomed` again, not by pk alone: a row confirmed (made THE photo) between the select and
            # here no longer matches and is not deleted (photo purge audit).
            deleted = doomed.filter(pk__in=[pk for pk, _key, _size in chunk]).delete()[0]
            if not deleted:
                # Nothing went although rows were selected: stop rather than select them for ever.
                logger.error("inventory: photo purge deleted 0 of %s selected rows; stopping", len(chunk))
                break
            transaction.on_commit(lambda blobs=blobs: _purge_blobs(blobs))
        rows += deleted
        objects += len(blobs)
    logger.info(
        "inventory: purged %s removed or abandoned photo row(s), %s object(s) sent to the storage sweep, before %s",
        rows,
        objects,
        cutoff.isoformat(),
    )
    return rows
