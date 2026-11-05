# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import uuid

# Module imports
from plane.db.models import Issue, UserFavorite

# Real sub-item nesting is two or three levels; this only stops a parent cycle in the data from
# looping forever. Each turn is one query, so the bound costs nothing in the normal case.
_MAX_DEPTH = 20


def _as_uuid(value):
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def drop_work_item_favorites(issue_ids, project_id):
    """Remove the sidebar pins of these work items and of every sub-item below them (APLANE-29).

    Nothing else does it. `UserFavorite.entity_identifier` is a bare UUIDField, so no database
    cascade reaches it, and `soft_delete_related_objects` — which walks reverse relations — never
    sees `UserFavorite` from `Issue` (it does from Project and Workspace, which is why those
    deletes were always fine). So every work-item delete path has to clear the pins itself, the way
    the cycle, module, project and page views already do for their own entities.

    `Issue.parent` is CASCADE and `Issue.objects` is the plain soft-delete manager, so deleting a
    work item soft-deletes its whole sub-tree including archived and draft children — and their
    pins have to go too. Walked level by level, over `all_objects` so it does not matter whether
    the celery cascade has already soft-deleted them by the time we get here.

    Deliberately not scoped to a user: the work item is gone for everybody. Archiving must NOT
    call this — an archived work item keeps its pin (L4-03b), unlike an archived page.

    Returns the number of pins dropped. Safe to call after the delete; one bulk UPDATE at the end.
    """
    frontier = [_as_uuid(issue_id) for issue_id in issue_ids]
    if not frontier:
        return 0

    doomed = set(frontier)
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
