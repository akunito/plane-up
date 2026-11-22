# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Event pruning (brief: Ledger). Devices never send an operation older than 60 days, so 90 days of
# ledger is enough to recognise every duplicate delivery. A revert whose event was pruned is answered
# "gone", and a compare-and-set that needs a pruned step counts it as someone else's change.

import logging
from datetime import timedelta

from celery import shared_task
from django.utils import timezone

from plane.db.models import InventoryEvent

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
