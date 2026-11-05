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

    **`cascade=False` is mandatory on a QUERYSET delete.** `SoftDeletionQuerySet.delete()` is a
    bare `update(deleted_at=…)`: it never calls the instance `delete()`, so
    `soft_delete_related_objects` is never queued and the sub-items stay alive and listable. Taking
    their pins there would be the same wrong-pin-state bug this helper exists to fix, inverted —
    a pin vanishing from a work item the user can still open. (That bulk delete orphans sub-items
    at all is upstream's, and is not this helper's to fix.)

    The sub-tree pins are dropped eagerly while the cascade that justifies them is only
    *eventually* attempted: if the broker is down, the worker dies, or the task swallows an error
    (`deletion_task.py` catches per relation and prints), the children survive with no pins. Known
    and accepted — the alternative is leaving the stale rows that made B-10 a race.

    The child query is project-scoped while the cascade is NOT (it walks `parent_issue` across
    projects), so a cross-project sub-item's pin would be missed. Measured on prod 2026-11-05:
    133 sub-items, 0 with a parent in another project — and this fork's API cannot create one
    (`SubIssuesEndpoint` and both `IssueCreateSerializer.validate`s require the parent in the same
    project, and nothing moves an item between projects). If cross-project sub-issues ever land,
    drop `project_id` from the child query and scope the final filter by workspace instead.

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
