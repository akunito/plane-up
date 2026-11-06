# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from plane.db.models import UserRecentVisit


def drop_work_item_recent_visits(issue_ids, project_id, slug):
    """Remove the "recently visited" rows pointing at these work items (APLANE-37).

    Nothing else does. `UserRecentVisit.entity_identifier` is a bare UUIDField with no FK, so no
    database cascade reaches it, `soft_delete_related_objects` never sees it from `Issue`, and
    `hard_delete` only reaps rows whose OWN `deleted_at` is set — a row pointing at a deleted work
    item is itself alive, so it is never reaped. The recorder's eviction does not remove it either:
    it fires only at exactly 20 rows and is an INSTANCE delete, i.e. soft (`recent_visited_task.py`
    `recent_visited.delete()`), so an evicted row lives on with `deleted_at` set — invisible to the
    `objects` manager this helper filters through, and reaped only by `hard_delete`'s own sweep.

    Hard delete (`soft=False`), as `IssueViewSet.destroy` has always done here: this table is a
    small per-user cache, not a record of anything.

    `entity_name="issue"` lowercase is what the recorder is called with
    (`app/views/issue/base.py`); the `UserRecentVisit` entity enum's "ISSUE" is not used on this
    path.

    Not scoped to the caller: the work item is gone for everybody, so every user's row for it goes,
    exactly as with the sidebar pins.

    **Sub-items are deliberately NOT walked**, unlike `drop_work_item_favorites`. A dead row never
    renders: `WorkspaceRecentVisitSerializer.get_entity_data` catches `DoesNotExist` and returns
    `entity_data: null`, and the home widget filters those out. The cost is displacement, not a
    broken row — `UserRecentVisitViewSet.list` slices `[:20]` BEFORE anything filters the nulls and
    the recorder caps the list at 20, so a dead row occupies a slot and pushes a live one out of
    the widget (and if every row returned were dead, the widget renders an empty 250px box rather
    than its empty state, because it tests the pre-filter length). Recovering one cosmetic slot is
    not worth a sub-tree walk on every delete. A stale PIN, by contrast, renders in the sidebar,
    which is why that one walks.

    Returns the number of rows removed.
    """
    ids = [issue_id for issue_id in issue_ids if issue_id]
    if not ids:
        return 0
    # `delete(soft=False)` is a real delete, which returns Django's (count, {label: count});
    # the bare 0 above would make the return type inconsistent, so unwrap it.
    removed, _ = UserRecentVisit.objects.filter(
        project_id=project_id,
        workspace__slug=slug,
        entity_name="issue",
        entity_identifier__in=ids,
    ).delete(soft=False)
    return removed
