# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import logging

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


def _chunks(ids):
    ids = list(ids)
    for start in range(0, len(ids), _ID_CHUNK):
        yield ids[start : start + _ID_CHUNK]


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

    Returns `(deletes, updates, doomed_issue_ids, doomed_comment_ids)`:

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

    return (
        deletes,
        {key: len(pks) for key, pks in update_pks.items()},
        doomed_pks.get(Issue._meta.label, set()),
        doomed_pks.get(IssueComment._meta.label, set()),
    )


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


def _report(cutoff, deletes, updates):
    live = {label: entry["live"] for label, entry in deletes.items() if entry["live"]}
    logger.info(
        "hard_delete is OFF (HARD_DELETE_ENABLED=0), cutoff %s. "
        "It would DELETE %s. Of those, STILL LIVE (deleted_at IS NULL, i.e. data nobody asked to "
        "remove, and the number that decides whether arming this is safe): %s. "
        "It would also UPDATE (SET_NULL on rows it does NOT delete): %s",
        cutoff.isoformat(),
        {label: entry["total"] for label, entry in sorted(deletes.items())} or "nothing",
        dict(sorted(live.items())) or "none",
        dict(sorted(updates.items())) or "nothing",
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
        deletes, updates, doomed_issues, doomed_comments = _collect_doomed(cutoff)

        if not settings.HARD_DELETE_ENABLED:
            _report(cutoff, deletes, updates)
            return

        with transaction.atomic():
            detached, dropped = _clear_blocking_activity_links(doomed_issues, doomed_comments)
            # Named for what it is: the detach is unfiltered, so this includes rows the loop
            # below then deletes. It is NOT "history preserved".
            purged["db.IssueActivity (comment link cleared, incl. rows deleted after)"] = detached
            purged["db.IssueActivity (removed with their work item)"] = dropped

            for model in _models_this_task_deletes():
                count, _ = model.all_objects.filter(deleted_at__lt=cutoff).delete()
                if count:
                    label = model._meta.label
                    purged[label] = purged.get(label, 0) + count
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
