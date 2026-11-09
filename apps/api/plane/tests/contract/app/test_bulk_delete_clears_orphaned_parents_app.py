# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Bulk-deleting a parent leaves its sub-items alive, with `parent_id` cleared (APLANE-32).

`BulkDeleteIssuesEndpoint` ends in `issues.delete()` on a QUERYSET, and
`SoftDeletionQuerySet.delete()` is a bare `update(deleted_at=…)`: it never calls the instance
`delete()`, so `soft_delete_related_objects` is never queued and nothing cascades. Upstream's
result was a sub-item that stayed alive and listable while its `parent_id` pointed at a row that no
longer existed — the same user intent giving a different outcome depending on which delete path the
user took.

**The decision (Diego, 2026-11-09) was to keep the sub-items and clear the pointer**, not to make
bulk delete cascade. A bulk delete that removed work items the user never ticked would be a change
of delete semantics rather than a bug fix. So these tests assert the sub-item SURVIVES — they are
not a step towards cascading, and `cascade=False` in the pin walk stays correct because of them
(`test_bulk_delete_keeps_a_live_sub_items_pin` in test_issue_delete_drops_favorites_app.py pins the
other half, including the call count that would catch the endpoint starting to cascade).

What is NOT asserted, because it is not implemented: an activity row for the parent change. The
orphan's feed says nothing about why its parent vanished. That is recorded on the ticket rather
than hidden here.
"""

from unittest import mock

import pytest
from rest_framework import status

from django.utils import timezone

from plane.db.models import DraftIssue, Issue, Project, ProjectMember, State

pytestmark = pytest.mark.contract

BULK_URL = "/api/workspaces/{slug}/projects/{project_id}/bulk-delete-issues/"


@pytest.fixture(autouse=True)
def _no_broker(db):
    """The endpoint fans out to celery; these tests only care about the rows it leaves behind.

    Yields the patched `issue_activity` so a test can assert how many it queued. That matters
    because "no activity row for the parent change" is a DECISION, and without a count a future
    session that fabricates one per orphan would pass every other test here.
    """
    with (
        mock.patch("plane.db.mixins.soft_delete_related_objects"),
        mock.patch("plane.app.views.issue.base.issue_activity") as activity,
    ):
        yield activity


@pytest.fixture
def project(workspace, create_user):
    created = Project.objects.create(name="Orphans", identifier="ORP", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=created, member=create_user, role=20)
    # Only the project CREATE VIEW seeds DEFAULT_STATES; Project.save() does not. Without a state,
    # anything that reads issue.state.group raises before the request is even made.
    State.objects.create(
        name="Done",
        group="completed",
        color="#60646C",
        sequence=45000,
        default=True,
        project=created,
        workspace=workspace,
    )
    return created


def _issue(project, name="item", **kwargs):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, **kwargs)


def _archived(project, name="archived item", **kwargs):
    """Archived with a direct UPDATE: it is what `issue_objects` excludes, with no save() effects."""
    issue = _issue(project, name, **kwargs)
    Issue.all_objects.filter(pk=issue.pk).update(archived_at=timezone.now())
    return issue


def _bulk_delete(client, workspace, project, ids):
    return client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(i) for i in ids]},
        format="json",
    )


def _parent_id(issue):
    return Issue.all_objects.values_list("parent_id", flat=True).get(pk=issue.pk)


def _draft(project, parent, name="draft sub item"):
    return DraftIssue.objects.create(name=name, project=project, workspace=project.workspace, parent=parent)


def test_a_live_sub_item_survives_with_its_parent_cleared(session_client, workspace, project):
    parent = _issue(project, "parent")
    child = _issue(project, "sub item", parent=parent)

    response = _bulk_delete(session_client, workspace, project, [parent.id])

    assert response.status_code == status.HTTP_200_OK
    assert not Issue.objects.filter(pk=parent.pk).exists(), "the parent is deleted"
    assert Issue.objects.filter(pk=child.pk).exists(), (
        "the sub-item SURVIVES — this endpoint does not cascade, and that is the decision, not a gap"
    )
    assert _parent_id(child) is None, "and it no longer points at a row that does not exist"


def test_a_sub_item_in_the_recycle_bin_keeps_its_parent(session_client, workspace, project):
    """`parent_id` is the only record of where a soft-deleted item came from, and there is no
    restore path to rebuild it. Clearing it would destroy information nobody asked to remove."""
    parent = _issue(project, "parent")
    child = _issue(project, "already deleted sub item", parent=parent)
    Issue.all_objects.filter(pk=child.pk).update(deleted_at=timezone.now())

    _bulk_delete(session_client, workspace, project, [parent.id])

    assert _parent_id(child) == parent.pk, "a row in the recycle bin must keep its parent pointer"


def test_an_archived_sub_item_is_cleared_too(session_client, workspace, project):
    """`issue_objects` hides archived items, so filtering the orphans through it would leave the
    dangling pointer exactly where a user can still open the item and see it."""
    parent = _issue(project, "parent")
    child = _archived(project, "archived sub item", parent=parent)

    _bulk_delete(session_client, workspace, project, [parent.id])

    assert Issue.all_objects.filter(pk=child.pk, deleted_at__isnull=True).exists(), (
        "sanity: the archived sub-item is still alive, or this test proves nothing"
    )
    assert _parent_id(child) is None, "archived is still openable, so its pointer must be cleared"


def test_the_children_of_an_archived_id_that_was_not_deleted_keep_their_parent(session_client, workspace, project):
    """The keying trap, again (it already bit the pin cleanup). `issue_objects` excludes archived
    items, so an archived id in the request body is NOT deleted — and a cleanup keyed on the raw
    `issue_ids` would orphan the children of a parent that is still there."""
    parent = _archived(project, "archived parent")
    child = _issue(project, "sub item of a surviving parent", parent=parent)

    response = _bulk_delete(session_client, workspace, project, [parent.id])

    assert response.status_code == status.HTTP_200_OK
    assert Issue.all_objects.filter(pk=parent.pk, deleted_at__isnull=True).exists(), (
        "sanity: issue_objects must have excluded the archived parent, or this test proves nothing"
    )
    assert _parent_id(child) == parent.pk, "its parent survived, so the pointer must be left alone"


def test_a_grandchild_keeps_its_parent(session_client, workspace, project):
    """One level is the whole job: only the deleted rows vanish, so only their DIRECT children are
    orphaned. Walking the sub-tree would flatten a hierarchy nobody touched."""
    parent = _issue(project, "parent")
    child = _issue(project, "sub item", parent=parent)
    grandchild = _issue(project, "sub sub item", parent=child)

    _bulk_delete(session_client, workspace, project, [parent.id])

    assert _parent_id(child) is None
    assert _parent_id(grandchild) == child.pk, "its own parent is still alive and must stay its parent"


def test_a_sub_item_of_an_untouched_parent_is_not_cleared(session_client, workspace, project):
    """The over-reach control: the UPDATE must be keyed on the deleted ids, not on the project."""
    deleted_parent = _issue(project, "deleted parent")
    other_parent = _issue(project, "untouched parent")
    orphan = _issue(project, "sub item of the deleted one", parent=deleted_parent)
    bystander = _issue(project, "sub item of the other one", parent=other_parent)

    _bulk_delete(session_client, workspace, project, [deleted_parent.id])

    assert _parent_id(orphan) is None
    assert _parent_id(bystander) == other_parent.pk, "a whole-project update would have cleared this"


def test_clearing_the_parent_bumps_updated_at(session_client, workspace, project):
    """`QuerySet.update()` skips `auto_now`, so without an explicit `updated_at` the clients that
    poll `?updated_at__gt=` would never learn the parent changed and would show a sub-item still
    nested under a work item that no longer exists."""
    parent = _issue(project, "parent")
    child = _issue(project, "sub item", parent=parent)
    before = Issue.all_objects.values_list("updated_at", flat=True).get(pk=child.pk)

    _bulk_delete(session_client, workspace, project, [parent.id])

    after = Issue.all_objects.values_list("updated_at", flat=True).get(pk=child.pk)
    assert after > before, "the sub-item changed, so the sync clients have to be able to see it"


# --- what the audit found missing ----------------------------------------------------------------


def test_a_second_project_in_the_same_workspace_is_untouched(session_client, workspace, create_user, project):
    """The scoping terms, which nothing else here pins.

    Every other test lives in one project, and `deleted_ids` are UUIDs — so dropping
    `workspace__slug` or `project_id` from the UPDATE leaves all of them green while the statement
    becomes workspace-wide, then global. This endpoint's sibling fix already shipped a keying bug of
    exactly this family, so the scoping gets its own fixture.
    """
    other = Project.objects.create(name="Other", identifier="OTH", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=other, member=create_user, role=20)
    State.objects.create(
        name="Done",
        group="completed",
        color="#60646C",
        sequence=45000,
        default=True,
        project=other,
        workspace=workspace,
    )
    here_parent = _issue(project, "parent here")
    here_child = _issue(project, "sub item here", parent=here_parent)
    there_parent = _issue(other, "parent there")
    there_child = _issue(other, "sub item there", parent=there_parent)

    _bulk_delete(session_client, workspace, project, [here_parent.id, there_parent.id])

    assert _parent_id(here_child) is None, "the project in the URL is cleared"
    assert Issue.objects.filter(pk=there_parent.pk).exists(), (
        "sanity: the other project's parent is not even deleted — issue_objects is filtered on the "
        "URL's project_id, so an id from elsewhere is not in deleted_ids"
    )
    assert _parent_id(there_child) == there_parent.pk, "and nothing outside that project is written"


def test_a_parent_and_its_child_in_the_same_request(session_client, workspace, project):
    """The likeliest real input: the user ticks a parent and one of its sub-items together.

    Reads as if it contradicts the grandchild test, so it is spelled out: both ticked rows are in
    `deleted_ids`, so the grandchild's pointer is cleared, while the middle row keeps its own
    `parent_id` because by then its `deleted_at` is set and it is in the recycle bin.
    """
    parent = _issue(project, "parent")
    child = _issue(project, "sub item", parent=parent)
    grandchild = _issue(project, "sub sub item", parent=child)

    _bulk_delete(session_client, workspace, project, [parent.id, child.id])

    assert not Issue.objects.filter(pk=parent.pk).exists()
    assert not Issue.objects.filter(pk=child.pk).exists()
    assert _parent_id(child) == parent.pk, "the deleted middle row keeps its pointer, like any recycled row"
    assert Issue.objects.filter(pk=grandchild.pk).exists(), "the surviving grandchild is still alive"
    assert _parent_id(grandchild) is None, "and its parent is gone, so its pointer is cleared"


def test_a_draft_sub_item_of_a_deleted_parent_is_cleared_too(session_client, workspace, project):
    """`DraftIssue.parent` is the other dangling pointer, and the one that becomes data loss.

    It is a CASCADE FK to `Issue`, writable through the issue modal's parent picker. The
    single-item delete soft-deletes the draft, because `soft_delete_related_objects` walks every
    reverse CASCADE relation including `draft_parent_issue`. This endpoint does not — so before the
    fix the user's draft kept pointing at a deleted work item, and when that parent left the
    recycle bin the database CASCADE deleted the draft outright.
    """
    parent = _issue(project, "parent")
    draft = _draft(project, parent)

    _bulk_delete(session_client, workspace, project, [parent.id])

    assert DraftIssue.objects.filter(pk=draft.pk).exists(), "the draft is the user's unsaved work; it stays"
    assert DraftIssue.all_objects.values_list("parent_id", flat=True).get(pk=draft.pk) is None, (
        "and it stops pointing at a work item that no longer exists"
    )


def test_a_draft_of_a_parent_that_was_not_deleted_keeps_it(session_client, workspace, project):
    """The over-reach control for the draft sweep, keyed the same way as the issue one."""
    deleted_parent = _issue(project, "deleted parent")
    other_parent = _issue(project, "untouched parent")
    orphan = _draft(project, deleted_parent, "draft of the deleted one")
    bystander = _draft(project, other_parent, "draft of the other one")

    _bulk_delete(session_client, workspace, project, [deleted_parent.id])

    assert DraftIssue.all_objects.values_list("parent_id", flat=True).get(pk=orphan.pk) is None
    assert DraftIssue.all_objects.values_list("parent_id", flat=True).get(pk=bystander.pk) == other_parent.pk


def test_no_activity_row_is_written_for_the_parent_change(session_client, workspace, project, _no_broker):
    """The decision, pinned. One `issue.activity.deleted` per DELETED id and nothing else.

    Fabricating an `issue.activity.updated` per orphan would invent a user action nobody took, with
    a payload nothing here can validate against what the feed renders. If that is ever reconsidered
    it has to be a deliberate change, not something that slips in green.
    """
    parent = _issue(project, "parent")
    _issue(project, "sub item", parent=parent)
    _draft(project, parent)

    _bulk_delete(session_client, workspace, project, [parent.id])

    assert _no_broker.delay.call_count == 1, (
        f"exactly one activity row, for the one deleted work item, got {_no_broker.delay.call_count}"
    )
    assert _no_broker.delay.call_args.kwargs["type"] == "issue.activity.deleted"
