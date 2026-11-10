# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import logging
from typing import NamedTuple

# Django imports
from django.utils import timezone
from django.apps import apps
from django.conf import settings
from django.db import models, router, transaction
from django.db.models.deletion import Collector
from django.db.models.fields.related import OneToOneRel


# Third party imports
from celery import shared_task

# Module imports
from plane.utils.exception_logger import log_exception

logger = logging.getLogger("plane.worker")


@shared_task
def soft_delete_related_objects(app_label, model_name, instance_pk, using=None):
    """
    Soft delete related objects for a given model instance
    """
    # Get the model class using app registry
    model_class = apps.get_model(app_label, model_name)

    # Get the instance using all_objects to ensure we can get even if it's already soft deleted
    try:
        instance = model_class.all_objects.get(pk=instance_pk)
    except model_class.DoesNotExist:
        return

    # Get all related fields that are reverse relationships
    all_related = [
        f for f in instance._meta.get_fields() if (f.one_to_many or f.one_to_one) and f.auto_created and not f.concrete
    ]

    # Handle each related field
    for relation in all_related:
        related_name = relation.get_accessor_name()

        # Skip if the relation doesn't exist
        if not hasattr(instance, related_name):
            continue

        # Get the on_delete behavior name
        on_delete_name = relation.on_delete.__name__ if hasattr(relation.on_delete, "__name__") else ""

        if on_delete_name == "DO_NOTHING":
            continue

        elif on_delete_name == "SET_NULL":
            # Handle SET_NULL relationships
            if isinstance(relation, OneToOneRel):
                # For OneToOne relationships
                related_obj = getattr(instance, related_name, None)
                if related_obj and isinstance(related_obj, models.Model):
                    setattr(related_obj, relation.remote_field.name, None)
                    related_obj.save(update_fields=[relation.remote_field.name])
            else:
                # For other relationships
                related_queryset = getattr(instance, related_name).all()
                related_queryset.update(**{relation.remote_field.name: None})

        else:
            # Handle CASCADE and other delete behaviors
            try:
                if relation.one_to_one:
                    # Handle OneToOne relationships
                    related_obj = getattr(instance, related_name, None)
                    if related_obj:
                        if hasattr(related_obj, "deleted_at"):
                            if not related_obj.deleted_at:
                                related_obj.deleted_at = timezone.now()
                                related_obj.save()
                                # Recursively handle related objects
                                soft_delete_related_objects(
                                    related_obj._meta.app_label,
                                    related_obj._meta.model_name,
                                    related_obj.pk,
                                    using,
                                )
                else:
                    # Handle other relationships
                    related_queryset = getattr(instance, related_name)(manager="objects").all()

                    for related_obj in related_queryset:
                        if hasattr(related_obj, "deleted_at"):
                            if not related_obj.deleted_at:
                                related_obj.deleted_at = timezone.now()
                                related_obj.save()
                                # Recursively handle related objects
                                soft_delete_related_objects(
                                    related_obj._meta.app_label,
                                    related_obj._meta.model_name,
                                    related_obj.pk,
                                    using,
                                )
            except Exception as e:
                # Log the error or handle as needed
                print(f"Error handling relation {related_name}: {str(e)}")
                continue

    # Finally, soft delete the instance itself if it hasn't been deleted yet
    if hasattr(instance, "deleted_at") and not instance.deleted_at:
        instance.deleted_at = timezone.now()
        instance.save()


# @shared_task
def restore_related_objects(app_label, model_name, instance_pk, using=None):
    pass


# Postgres caps bind parameters at 65535 and Django does not batch `__in` on it
# (`BaseDatabaseOperations.bulk_batch_size` returns len(objs) and Postgres does not override it),
# so the hand-written id filters below are chunked. NOT covered by this: `Collector.collect`
# builds its own `Q(pk__in=objs)` over the full doomed list, so a single model with more than
# ~65k doomed rows breaks inside the collection phase — which now runs in the disarmed path too.
_ID_CHUNK = 10000

# S3's DeleteObjects takes at most 1000 keys per request, so the storage sweep chunks on its own
# size rather than the bind-parameter one above.
_KEY_CHUNK = 1000

# How many kept keys the "still referenced" warning names. Capped because on a pre-2024-10-09
# instance every legacy attachment lands in it every night (see `_delete_blobs`), and the line it
# would otherwise write is long enough for the log driver to split or drop.
_WARN_SAMPLE = 20


def _chunks(ids, size=_ID_CHUNK):
    ids = list(ids)
    for start in range(0, len(ids), size):
        yield ids[start : start + size]


class _Doomed(NamedTuple):
    """Everything the collection phase learned, read before a single row is deleted.

    `description_ids` and `blobs` exist because their targets are unreachable once the purge has
    run (APLANE-41): the key of a storage object lives only in its row, and a `Description` is
    pointed AT by its comment, so neither can be found again afterwards.
    """

    deletes: dict
    updates: dict
    issue_ids: set
    comment_ids: set
    description_ids: set
    blobs: list


def _purge_models():
    """The models this task purges first, in upstream's order: parents before children, so their
    own cascades do most of the work and the later steps only reach rows whose parent survived."""
    from plane.db.models import (
        Workspace,
        Project,
        Cycle,
        Module,
        Issue,
        Page,
        IssueView,
        Label,
        State,
        IssueActivity,
        IssueComment,
        IssueLink,
        IssueReaction,
        UserFavorite,
        ModuleIssue,
        CycleIssue,
        Estimate,
        EstimatePoint,
    )

    return (
        Workspace,
        Project,
        Cycle,
        Module,
        Issue,
        Page,
        IssueView,
        Label,
        State,
        IssueActivity,
        IssueComment,
        IssueLink,
        IssueReaction,
        UserFavorite,
        ModuleIssue,
        CycleIssue,
        Estimate,
        EstimatePoint,
    )


def _models_this_task_deletes():
    """Every model this task deletes from, in order: the explicit list, then anything else with a
    `deleted_at` (upstream's catch-all sweep).

    `_collect_doomed` walks exactly this list, which is the only honest way to know what the
    deletes will cascade into. Keying the activity clearing on a hand-written filter instead is
    what broke the first version of this fix: `Description` reaches `IssueComment` through a
    CASCADE one-to-one (db/models/issue.py:455), and nothing in the explicit list covers it.
    """
    ordered = _purge_models()
    seen = set(ordered)
    return ordered + tuple(model for model in apps.get_models() if hasattr(model, "deleted_at") and model not in seen)


def _collect_doomed(cutoff):
    """Ask Django's own collector what every step of this task would do.

    Returns a `_Doomed`:

    - `deletes` — `{label: {"total": n, "live": m}}`, `live` counting rows whose own `deleted_at`
      is NULL. **That live number is the one that decides whether arming this is safe**: an `Issue`
      is cascade-deleted through four paths (`project`, `workspace`, `parent` self and `state`, all
      CASCADE), so a purge takes live sub-items of a purged parent and live work items sitting in a
      purged state. They are alive precisely because a `soft_delete_related_objects` was lost, and
      nothing but this report can tell an operator how many there are.
    - `updates` — `{"label.field": n}` for rows a purge would WRITE rather than delete: every
      SET_NULL relation lands in `collector.field_updates`, and those rows are typically alive
      (purging `IssueActivity` nulls `issue_versions.activity_id`). A report that only counted
      deletions could not show that.

    Two things this gets right that the first version did not, both found by audit:

    - **Rows are deduped across collectors.** A doomed Project collects its doomed Issues, and the
      Issue iteration of the same loop collects them again; accumulating counts per label gave a
      number inflated by an unbounded factor, which is worse than useless for a gate — you cannot
      tell "100 live rows" from "33 counted three times".
    - **`live` is counted with one query per model, not by reading `deleted_at` off the
      instances.** `Collector.collect` does `sub_objs.only(*referenced_fields)` (Django 5.2
      deletion.py:342) whenever no delete signal receiver exists — and this codebase has none — so
      every collected object arrives with `deleted_at` DEFERRED, and touching it would fire one
      SELECT per row, nightly, in the disarmed path.

    `collect()` itself is read-only: it records SET_NULL work in `field_updates` without executing
    it, and loads the doomed rows just as the real `.delete()` will, so the cost is paying for that
    collection twice.
    """
    from plane.db.models import Issue, IssueComment

    doomed_pks = {}
    models_by_label = {}
    update_pks = {}

    for model in _models_this_task_deletes():
        roots = list(model.all_objects.filter(deleted_at__lt=cutoff))
        if not roots:
            continue
        # The WRITE database: `Manager.db` resolves through `db_for_read`, and this set has to be
        # the one the deletes act on. They agree today only because the read-replica router
        # defaults to the primary outside a request.
        collector = Collector(using=router.db_for_write(model))
        collector.collect(roots)

        for related_model, instances in collector.data.items():
            label = related_model._meta.label
            models_by_label[label] = related_model
            doomed_pks.setdefault(label, set()).update(obj.pk for obj in instances)
        for queryset in collector.fast_deletes:
            label = queryset.model._meta.label
            models_by_label[label] = queryset.model
            doomed_pks.setdefault(label, set()).update(queryset.values_list("pk", flat=True))
        for (field, _value), instances_list in collector.field_updates.items():
            key = f"{field.model._meta.label}.{field.name}"
            for instances in instances_list:
                pks = (
                    instances.values_list("pk", flat=True)
                    if hasattr(instances, "values_list")
                    else [obj.pk for obj in instances]
                )
                update_pks.setdefault(key, set()).update(pks)

    deletes = {}
    for label, pks in doomed_pks.items():
        model = models_by_label[label]
        if hasattr(model, "deleted_at"):
            live = 0
            for chunk in _chunks(pks):
                live += model._base_manager.filter(pk__in=chunk, deleted_at__isnull=True).count()
        else:
            # No soft-delete column at all, so every one of these rows is live by definition.
            live = len(pks)
        deletes[label] = {"total": len(pks), "live": live}

    comment_ids = doomed_pks.get(IssueComment._meta.label, set())
    # The comments' `description_id`s have to be read while the comments still exist: the pointer
    # is on the comment, so once it is deleted there is nothing left that names its `Description`.
    description_ids = set()
    for chunk in _chunks(comment_ids):
        description_ids.update(
            IssueComment._base_manager.filter(pk__in=chunk, description_id__isnull=False).values_list(
                "description_id", flat=True
            )
        )

    return _Doomed(
        deletes=deletes,
        updates={key: len(pks) for key, pks in update_pks.items()},
        issue_ids=doomed_pks.get(Issue._meta.label, set()),
        comment_ids=comment_ids,
        description_ids=description_ids,
        blobs=_doomed_blobs(doomed_pks),
    )


def _blob_fields():
    """`(model, field name)` for every `FileField` in the model layer.

    There are exactly two — `FileAsset.asset` (db/models/asset.py:50) and `IssueAttachment.asset`
    (db/models/issue.py:400) — but they are found by scanning rather than hardcoded: a third added
    upstream would otherwise start leaking objects in silence, which is the shape of the bug this
    fixes. `_meta.fields`, not `local_fields`, so a field inherited from a CONCRETE parent is seen
    too; the promise of the scan is worthless with a hole in it.

    Only `FileField`s, which is narrower than "everything that names an object": `IssueComment`
    and `IssueActivity` both carry an `ArrayField(URLField)` called `attachments` that holds
    attachment URLs on pre-0079 instances. Nothing in the codebase resolves those back to objects,
    so nothing here depends on them. A future `FileField` on a non-S3 `storage=` would also be
    swept against the Plane bucket by this task — there is none today.
    """
    return [
        (model, field.name)
        for model in apps.get_models()
        for field in model._meta.fields
        if isinstance(field, models.FileField)
    ]


def _doomed_blobs(doomed_pks):
    """`[(storage key, bytes)]` for every doomed row that owns an object in the bucket.

    Read during collection, before anything is deleted, because the key exists ONLY in the row:
    `FileAsset`'s seven owner foreign keys (user, workspace, draft_issue, project, issue, comment,
    page) and `IssueAttachment.issue` are all CASCADE, so a purge
    removes the row and leaves behind an object nothing can name again short of listing the whole
    bucket. `size` is read where the model has the column (`FileAsset` only) so the disarmed report
    can state bytes rather than a row count.
    """
    blobs = []
    for model, field in _blob_fields():
        pks = doomed_pks.get(model._meta.label)
        if not pks:
            continue
        has_size = any(f.name == "size" for f in model._meta.fields)
        columns = (field, "size") if has_size else (field,)
        # `.using(db_for_write)` for the same reason the collector above pins it: these reads have
        # to see the database the deletes act on, and `ReadReplicaRouter` is installed whenever
        # DATABASE_READ_REPLICA_URL is set. It agrees with the primary outside a request only
        # because `should_use_read_replica()` defaults to False.
        reader = model._base_manager.using(router.db_for_write(model))
        for chunk in _chunks(pks):
            for row in reader.filter(pk__in=chunk).values_list(*columns):
                if row[0]:
                    blobs.append((row[0], int(row[1] or 0) if has_size else 0))
    return blobs


def _keys_still_referenced(keys):
    """`{key: {model label, …}}` for the keys a SURVIVING row still points at.

    Run after the purge has committed, so anything that comes back belongs to a row the purge did
    not touch. The labels are carried because of the legacy case below: a nightly warning that
    names the table is a diagnosis, one that only counts keys is noise.

    Chunked on `_KEY_CHUNK` rather than `_ID_CHUNK`: `FileAsset.asset` is `max_length=800`, so
    10 000 of them in one `IN` list is megabytes of query text. `issue_attachments.asset` has no
    index either (only `file_assets` has `asset_asset_idx`), so each chunk is a sequential scan of
    that table — tolerable because it is empty on any instance created after October 2024.
    """
    keys = list(keys)
    survivors = {}
    for model, field in _blob_fields():
        reader = model._base_manager.using(router.db_for_write(model))
        for chunk in _chunks(keys, _KEY_CHUNK):
            for key in reader.filter(**{f"{field}__in": chunk}).values_list(field, flat=True):
                survivors.setdefault(key, set()).add(model._meta.label)
    return survivors


def _purge_blobs(blobs):
    """Delete the storage objects whose rows the purge just removed (APLANE-41).

    Registered with `transaction.on_commit`, not called after the `with` block: the whole safety
    property of this function is that it runs only once Postgres has accepted the purge, and
    statement order makes that positional — true for the one caller today (celery beat,
    `plane/celery.py:62`) and false the moment anything calls the task inside an outer atomic
    block, where the inner `atomic()` degrades to a savepoint and this would run BEFORE the commit.
    A rollback would then leave every row alive and its object gone, with `restore_related_objects`
    a stub. `on_commit` cannot run early, and Django discards the callback if the block rolls back.

    **This function must never raise.** It runs inside the commit of the outermost atomic block, so
    an exception here would surface from `hard_delete`'s own `except` and be reported as "the whole
    transaction rolled back, so NOTHING was purged" — about a purge that did commit, which is a
    worse lie than the failure. `S3Storage.delete_files` only catches `ClientError`, so
    `EndpointConnectionError`, `NoCredentialsError` and the rest of `BotoCoreError` reach us.

    The keys are logged per batch BEFORE each delete, because they are gone from the database by
    then and that line is the only thing an operator could still find the objects by. Per batch and
    not in one line on purpose: docker's json-file driver splits at 16 KB and Loki drops oversized
    lines, so the one log entry that has to survive is the one not worth writing as a 5 MB string.

    Done inline rather than queued as its own celery task: a lost or failed message would put the
    keys in the broker instead of the log and turn a loud failure into a silent leak.

    `S3Storage` is imported here, not at module level, because `plane.db.mixins` imports this
    module: a top-level import would pull boto3 and django-storages into the import chain of every
    model. Same reason every model import in this file is function-local.
    """
    if not blobs:
        return

    try:
        _delete_blobs(blobs)
    except Exception as exc:
        # See above: raising from here would make `hard_delete` report a committed purge as a
        # total rollback.
        logger.error("hard_delete: the storage sweep itself failed; the rows are already purged")
        log_exception(exc)


def _delete_blobs(blobs):
    keys = {key for key, _size in blobs}
    still_referenced = _keys_still_referenced(keys)
    if still_referenced:
        # Routine on an instance that predates October 2024, not insurance: migration
        # 0079_auto_20241009_0619 copied every `issue_attachments.asset` into a new `file_assets`
        # row VERBATIM and did not delete the old rows, so each pre-migration attachment has two
        # rows naming one object. Deleting such an attachment through the UI sets `deleted_at` on
        # the `FileAsset` row only, so this guard then keeps the key for ever and the object leaks
        # anyway — the half of this fix that legacy data does not get. Measured 2026-11-09:
        # `issue_attachments` is EMPTY on our instance (0 rows in the prod copy on dev), so there
        # are no such pairs here; an instance that has them needs those rows reaped as well.
        # Keys are server-generated with a uuid4 everywhere else, so nothing else shares one.
        logger.warning(
            "hard_delete: %s storage key(s) are still referenced by surviving rows and were KEPT (first %s): %s",
            len(still_referenced),
            min(len(still_referenced), _WARN_SAMPLE),
            sorted(still_referenced.items())[:_WARN_SAMPLE],
        )
        keys -= still_referenced.keys()

    if not keys:
        return

    # `keys` is a set here, so this is one membership test per blob and no set rebuilt per item.
    total_bytes = sum(size for key, size in blobs if key in keys)
    keys = sorted(keys)

    from plane.settings.storage import S3Storage

    storage = S3Storage()
    requested = failed = 0
    for chunk in _chunks(keys, _KEY_CHUNK):
        logger.info("hard_delete: deleting %s storage object(s): %s", len(chunk), chunk)
        try:
            ok = storage.delete_files(object_names=chunk)
        except Exception as exc:
            ok = False
            log_exception(exc)
        if ok:
            requested += len(chunk)
        else:
            failed += len(chunk)
            logger.error(
                "hard_delete: storage delete FAILED for %s object(s). Their rows are already gone, "
                "so these keys are recoverable only from the line above",
                len(chunk),
            )
    # "Requested", not "deleted": `delete_objects` answers 200 with a per-key `Errors` array on a
    # partial failure and `delete_files` returns True without looking at it, so a single-object
    # failure inside a successful batch is invisible from here.
    logger.info(
        "hard_delete: storage sweep done — %s object(s) requested for deletion (%s bytes), %s failed",
        requested,
        total_bytes,
        failed,
    )


def _purge_orphaned_descriptions(description_ids):
    """Delete the `Description` rows the purged comments left behind (APLANE-41).

    `IssueComment.description` is a `OneToOneField` ON THE COMMENT (db/models/issue.py:455), so the
    CASCADE runs the other way: deleting a comment leaves its `Description`, and that row's
    `DescriptionVersion` children, behind for ever. `descriptions` and `description_versions` would
    grow for ever once anything purges comments.

    No code assigns `Description.deleted_at` literally — but `soft_delete_related_objects`, at the
    top of this file, walks reverse CASCADE relations reflectively, and `Description` is a
    `WorkspaceBaseModel` (workspace and project, both CASCADE). So soft-deleting a project or a
    workspace DOES mark its `Description` rows, and the catch-all sweep then reaps them: a non-zero
    `db.Description` line in the disarmed report is a real signal, not noise. What nothing reaches
    is the case this step exists for — a work item or a comment deleted on its own, where no code
    path ever touches the `Description` at all.

    Filtered on `issue_comment_description__isnull=True` ("nothing points at me any more") and not
    merely on the collected ids. The ids are read before the transaction opens, and the FK direction
    means a `Description` delete CASCADES INTO its comment: that guard is what makes this step
    incapable of destroying a live one.

    Purging a whole workspace or project already took these rows — `Description` is a
    `WorkspaceBaseModel`, so both of those FKs are CASCADE. This covers the case the leak actually
    comes from: a work item or a comment purged on its own.
    """
    from plane.db.models import Description

    removed = {}
    for chunk in _chunks(description_ids):
        _, per_model = Description.all_objects.filter(pk__in=chunk, issue_comment_description__isnull=True).delete()
        for label, count in per_model.items():
            removed[label] = removed.get(label, 0) + count
    return removed


def _clear_blocking_activity_links(doomed_issues, doomed_comments):
    """Clear the two DO_NOTHING foreign keys that made every purge fail (APLANE-40).

    `IssueActivity.issue` and `IssueActivity.issue_comment` are `on_delete=DO_NOTHING`
    (db/models/issue.py) but keep their database constraints — `db_constraint` is set nowhere in
    this codebase. Django honours DO_NOTHING by emitting a bare `DELETE FROM issues`, Postgres
    refuses it, and the task dies. Every work item carries an `issue.activity.created` row from
    creation, so this fired every single night; measured on prod 2026-11-06, 102 work items
    soft-deleted over 60 days earlier were all still present.

    **Only ever valid inside the same transaction as the deletes it unblocks.** It commits the
    removal of history belonging to work items that may still be alive, so on its own it is a
    data-loss bug: if a later step then failed, those items would survive with no activity feed
    and no way back (`restore_related_objects` is a stub).

    The two foreign keys get different treatment on purpose: a row whose work item is being purged
    goes with it, while a row pointing at a purged COMMENT is only detached. A comment can be
    deleted on an item nobody deleted, and dropping the row would erase part of a live item's
    history. The detach is not filtered against `doomed_issues` — a row that is both detached and
    then deleted costs one extra write and keeps the id lists chunkable.
    """
    from plane.db.models import IssueActivity

    detached = 0
    for chunk in _chunks(doomed_comments):
        detached += IssueActivity.all_objects.filter(issue_comment_id__in=chunk).update(issue_comment=None)

    dropped = 0
    for chunk in _chunks(doomed_issues):
        removed, _ = IssueActivity.all_objects.filter(issue_id__in=chunk).delete()
        dropped += removed

    return detached, dropped


def _report(cutoff, doomed):
    live = {label: entry["live"] for label, entry in doomed.deletes.items() if entry["live"]}
    logger.info(
        "hard_delete is OFF (HARD_DELETE_ENABLED=0), cutoff %s. "
        "It would DELETE %s. Of those, STILL LIVE (deleted_at IS NULL, i.e. data nobody asked to "
        "remove, and the number that decides whether arming this is safe): %s. "
        "It would also UPDATE (SET_NULL on rows it does NOT delete): %s. "
        "It would remove %s storage object(s) totalling at least %s bytes, and %s Description "
        "row(s) that the purged comments would otherwise leave behind for ever",
        cutoff.isoformat(),
        {label: entry["total"] for label, entry in sorted(doomed.deletes.items())} or "nothing",
        dict(sorted(live.items())) or "none",
        dict(sorted(doomed.updates.items())) or "nothing",
        # Deduped on the key, not `len(doomed.blobs)`: migration 0079 left pre-2024-10-09
        # attachments with a `file_assets` AND an `issue_attachments` row naming one object, so
        # counting rows would double every object this ticket is about. "At least" for the bytes:
        # `IssueAttachment` has no `size` column at all and `FileAsset.size` defaults to 0.
        len({key for key, _size in doomed.blobs}),
        sum(size for _key, size in doomed.blobs),
        len(doomed.description_ids),
    )


@shared_task
def hard_delete():
    """Purge rows soft-deleted longer than HARD_DELETE_AFTER_DAYS ago.

    See `_clear_blocking_activity_links` for why this had never purged a single work item, and
    `plane.settings.common.HARD_DELETE_ENABLED` for why it ships disarmed.

    Everything runs in ONE transaction. Upstream left each `.delete()` to its own atomic block,
    which is why the steps before the failing one had been committing all along — but the activity
    clearing this fix needs may only be committed together with the deletes it unblocks, and the
    deferred foreign keys are checked at that single COMMIT, which is exactly the guarantee wanted.
    The cost is that a failure now purges nothing instead of purging part.
    """
    days = settings.HARD_DELETE_AFTER_DAYS
    # Computed once. Upstream re-evaluated `timezone.now()` in all nineteen filters, so no two of
    # them referred to the same set of rows.
    cutoff = timezone.now() - timezone.timedelta(days=days)

    purged = {}
    try:
        doomed = _collect_doomed(cutoff)

        if not settings.HARD_DELETE_ENABLED:
            _report(cutoff, doomed)
            return

        with transaction.atomic():
            detached, dropped = _clear_blocking_activity_links(doomed.issue_ids, doomed.comment_ids)
            # Named for what it is: the detach is unfiltered, so this includes rows the loop
            # below then deletes. It is NOT "history preserved".
            purged["db.IssueActivity (comment link cleared, incl. rows deleted after)"] = detached
            purged["db.IssueActivity (removed with their work item)"] = dropped

            for model in _models_this_task_deletes():
                # Use the PER-LABEL dict, not the total. `QuerySet.delete()` returns
                # `(rows_deleted_across_every_model, {label: n})`, and this loop used to file that
                # grand total under the ROOT model's label and throw the breakdown away. Measured on
                # dev 2026-11-10: six doomed projects reported `db.Project: 309` — the whole cascade
                # attributed to the root — while exactly 6 project rows existed to delete (28 -> 22).
                # That is the line an operator reads to decide whether arming this on prod was safe,
                # and it could not be compared against the disarmed report above, whose counts ARE
                # per label because they come from the collector. Same number, two meanings.
                _, per_label = model.all_objects.filter(deleted_at__lt=cutoff).delete()
                for label, count in per_label.items():
                    if count:
                        purged[label] = purged.get(label, 0) + count

            # AFTER the loop, never before it: the one-to-one is on the comment, so removing a
            # `Description` whose comment still exists would cascade into the comment.
            for label, count in _purge_orphaned_descriptions(doomed.description_ids).items():
                key = f"{label} (left behind by a purged comment)"
                purged[key] = purged.get(key, 0) + count

            # Storage only once this COMMITs, and nothing at all if it rolls back. See
            # `_purge_blobs`: `on_commit` rather than a statement after the block, because the
            # ordering IS the safety property and position does not enforce it. The sweep logs its
            # own counts, which therefore land just before the summary line below.
            transaction.on_commit(lambda: _purge_blobs(doomed.blobs))
    except Exception as exc:
        # This used to propagate into celery with no log line of its own, which is how a task that
        # had never once completed went unnoticed for the whole life of the instance. The
        # collection phase is inside the try for the same reason: in the disarmed mode its report
        # IS the output, and a failure there would otherwise be silent.
        logger.error(
            "hard_delete failed and the whole transaction rolled back, so NOTHING was purged. "
            "The counts it had reached before failing, all of them rolled back: %s",
            dict(sorted(purged.items())) or "nothing",
        )
        log_exception(exc)
        raise

    logger.info("hard_delete purged %s (cutoff %s)", dict(sorted(purged.items())) or "nothing", cutoff.isoformat())
    return
