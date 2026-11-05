# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import uuid

# Module imports
from plane.db.models import Issue, UserFavorite

# Real sub-item nesting is two or three levels. `exclude(pk__in=doomed)` already terminates a
# parent cycle on its own (the next level comes back empty), so this is belt-and-braces; each turn
# is one query, so the bound costs nothing in the normal case.
_MAX_DEPTH = 20


def _as_uuid(value):
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def drop_work_item_favorites(issue_ids, project_id, *, cascade=True):
    """Remove the sidebar pins of these work items, and of every sub-item below them (APLANE-29).

    Nothing else does it. `UserFavorite.entity_identifier` is a bare UUIDField, so no database
    cascade reaches it, and `soft_delete_related_objects` — which walks reverse relations — never
    sees `UserFavorite` from `Issue` (it does from Project and Workspace, which is why those
    deletes were always fine). So every work-item delete path has to clear the pins itself, the way
    the cycle, module, project and page views already do for their own entities.

    `Issue.parent` is CASCADE and `Issue.objects` is the plain soft-delete manager, so deleting a
    work item instance soft-deletes its whole sub-tree including archived and draft children — and
    their pins have to go too. Walked level by level, over `all_objects` so it does not matter
    whether the celery cascade has already soft-deleted them by the time we get here.

    **`cascade=False` is mandatory on a SOFT queryset delete.** `SoftDeletionQuerySet.delete()` is
    a bare `update(deleted_at=…)`: it never calls the instance `delete()`, so
    `soft_delete_related_objects` is never queued and the sub-items stay alive and listable. Taking
    their pins there would be the same wrong-pin-state bug this helper exists to fix, inverted —
    a pin vanishing from a work item the user can still open. (That bulk delete orphans sub-items
    at all is upstream's, and is not this helper's to fix.)

    The opposite holds for a HARD queryset delete: `all_objects` is a plain `models.Manager`, so
    `Issue.all_objects.filter(…).delete()` (as in `deletion_task.hard_delete`) is Django's real
    delete and DOES cascade to the children for real. Do not read the rule above as "queryset ⇒
    cascade=False"; read the delete.

    The sub-tree pins are dropped eagerly, while the cascade that justifies them is attempted
    exactly ONCE, best-effort, and never retried: `soft_delete_related_objects` is a bare
    `@shared_task` with no `autoretry_for`, its relation loop catches per relation and only prints,
    and nothing reconciles afterwards. So if the broker is down, the worker dies, or one child's
    save() raises, those children stay alive and listable with no pins — permanently, not just for
    a while. Known and accepted: the alternative is the stale rows that made B-10 a race, and an
    orphaned sub-item can simply be re-pinned.

    Both queries are project-scoped while the cascade is NOT (it walks `parent_issue` across
    projects), so a cross-project sub-item's pin would be missed, and so would a pin row whose own
    `project_id` does not match its issue. Measured on prod 2026-11-05: 133 sub-items, 0 with a
    parent in another project; 8 live issue pins, 0 with a mismatched or NULL `project_id`, 0
    already orphaned (so no backfill was needed). This fork's API cannot create either case
    (`SubIssuesEndpoint` and both `IssueCreateSerializer.validate`s require the parent in the same
    project; `WorkspaceFavoriteEndpoint.post` validates the issue through `project_id`). If
    cross-project sub-issues ever land, drop `project_id` from both queries and scope by workspace.

    Deliberately not scoped to a user: the work item is gone for everybody. Archiving must NOT
    call this — an archived work item keeps its pin (L4-03b), unlike an archived page.

    Returns the number of pins dropped. Safe to call after the delete; one bulk UPDATE at the end.
    """
    frontier = [_as_uuid(issue_id) for issue_id in issue_ids]
    if not frontier:
        return 0

    doomed = set(frontier)
    if cascade:
        for _ in range(_MAX_DEPTH):
            children = list(
                Issue.all_objects.filter(project_id=project_id, parent_id__in=frontier)
                .exclude(pk__in=doomed)
                .values_list("id", flat=True)
            )
            if not children:
                break
            doomed.update(children)
            frontier = children

    return UserFavorite.objects.filter(
        entity_type="issue", entity_identifier__in=doomed, project_id=project_id
    ).delete()
