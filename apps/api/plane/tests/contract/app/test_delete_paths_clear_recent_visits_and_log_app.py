# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every work-item delete path clears the recently-visited rows and logs the deletion (APLANE-37).

Only the app's `IssueViewSet.destroy` did both. The other four — the external API's delete, the
bulk delete, and the two intake deletes — cleared no `UserRecentVisit` rows, and three of them
queued no `issue.activity.deleted` either, so a delete through intake or in bulk left no trace in
anyone's activity feed while the same delete from the work-item view did.

Neither row is cleaned by anything else. `UserRecentVisit.entity_identifier` is a bare UUIDField
with no FK, and `hard_delete` only reaps rows whose own `deleted_at` is set, so a row pointing at a
deleted work item is itself alive and is never reaped (only the recorder's 20-row FIFO eviction
removes it). `IssueActivity.issue` is `DO_NOTHING` and the soft-delete cascade skips DO_NOTHING, so
the activity row outlives the work item and stays readable by the feeds that do not join the issue.

The activity assertions are on `issue_activity.delay`, not on the row: writing the row is
upstream's task, exercised elsewhere, and what this change controls is whether the view asks for
it. The controls matter more than the five happy paths — an ACCEPTED intake item keeps its work
item and must therefore keep its visit row and log nothing.
"""

from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from django.test import RequestFactory

from plane.db.models import (
    Intake,
    IntakeIssue,
    Issue,
    Project,
    ProjectMember,
    State,
    User,
    UserRecentVisit,
    WorkspaceMember,
)
from plane.utils.host import base_host

# 58 of the 63 files in this directory carry it, TESTING_GUIDE asks for it, and pytest.ini sets
# --strict-markers but no default -m: without this, `pytest -m contract` silently skips all of it.
pytestmark = pytest.mark.contract

APP_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{pk}/"
BULK_URL = "/api/workspaces/{slug}/projects/{project_id}/bulk-delete-issues/"
API_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/issues/{pk}/"
APP_INTAKE_URL = "/api/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"
API_INTAKE_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"


@pytest.fixture(autouse=True)
def activity(db):
    """Patch the four call sites' `issue_activity` and yield them, keyed by path."""
    with (
        mock.patch("plane.db.mixins.soft_delete_related_objects"),
        mock.patch("plane.app.views.issue.base.issue_activity") as app_issue,
        mock.patch("plane.api.views.issue.issue_activity") as api_issue,
        mock.patch("plane.app.views.intake.base.issue_activity") as app_intake,
        mock.patch("plane.api.views.intake.issue_activity") as api_intake,
    ):
        yield {"app": app_issue, "api": api_issue, "app_intake": app_intake, "api_intake": api_intake}


@pytest.fixture
def project(workspace, create_user):
    created = Project.objects.create(
        name="Visited", identifier=f"VI{uuid4().hex[:3]}", workspace=workspace, intake_view=True
    )
    ProjectMember.objects.create(workspace=workspace, project=created, member=create_user, role=20)
    # Not a triage state on purpose: Issue.issue_objects excludes triage, so the bulk endpoint
    # would silently delete nothing and every bulk assertion here would pass vacuously.
    State.objects.create(
        name="Done", group="completed", color="#60646C", default=True, project=created, workspace=workspace
    )
    return created


@pytest.fixture
def intake(project):
    return Intake.objects.create(name="Intake", project=project, workspace=project.workspace, is_default=True)


def _issue(project, name="visited item", **kwargs):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, **kwargs)


def _visit(user, issue, project):
    return UserRecentVisit.objects.create(
        user=user,
        entity_name="issue",
        entity_identifier=issue.id,
        project=project,
        workspace=project.workspace,
    )


def _alive(visit):
    """The rows are hard-deleted, so `all_objects` is the honest check."""
    return UserRecentVisit.all_objects.filter(pk=visit.pk).exists()


def _deleted_activity_calls(queued):
    """The kwargs of every deletion the view asked to log."""
    return [call.kwargs for call in queued.delay.call_args_list if call.kwargs.get("type") == "issue.activity.deleted"]


def _deleted_activity_ids(queued):
    return [kwargs["issue_id"] for kwargs in _deleted_activity_calls(queued)]


def _assert_log_shape(kwargs, issue, project):
    """Pin every argument, not just the id.

    The first version of this file asserted `type` and `issue_id` only, and an audit found an
    `is_app=False` in one of the four new call sites that no test could have caught — the odd one
    out among 25 `base_host` calls in that tree, including its own neighbour in the same file.
    """
    assert kwargs["issue_id"] == str(issue.id)
    assert kwargs["project_id"] == str(project.id)
    assert kwargs["notification"] is False, (
        "notification=True informs nobody here: notifications() resolves the issue through "
        "Issue.objects, which is None after the soft delete, and its subscriber loop then reads "
        "issue.created_by_id -> AttributeError -> a bare `except Exception: print(e)`"
    )
    assert kwargs["subscriber"] is False, "True would get_or_create a subscriber row for a dead issue"
    assert kwargs["current_instance"] == {}, "delete_issue_activity never reads it"
    # Computed, not hardcoded: re-implementing base_host here would assert my own belief about it.
    assert kwargs["origin"] == base_host(request=RequestFactory().get("/"), is_app=True)


def _other_member(workspace, project):
    user = User.objects.create(email=f"bob-{uuid4().hex[:8]}@plane.so", username=f"bob_{uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=20)
    return user


# --- the five paths -----------------------------------------------------------------------------


def test_app_destroy_clears_the_visit_and_logs(session_client, workspace, project, create_user, activity):
    """The reference implementation, asserted so the helper refactor cannot have broken it."""
    issue = _issue(project)
    visit = _visit(create_user, issue, project)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not _alive(visit)
    assert _deleted_activity_ids(activity["app"]) == [str(issue.id)]
    _assert_log_shape(_deleted_activity_calls(activity["app"])[0], issue, project)


def test_api_delete_clears_the_visit(api_key_client, workspace, project, create_user, activity):
    issue = _issue(project, created_by=create_user)
    visit = _visit(create_user, issue, project)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not _alive(visit)
    # Only the id: this path's activity call is pre-existing and has its own shape — it passes no
    # `notification`/`subscriber` at all and a fully serialized `current_instance` that
    # delete_issue_activity never reads. Left alone; asserting the shape added here would be
    # asserting a convention this call has never followed.
    assert _deleted_activity_ids(activity["api"]) == [str(issue.id)], "this path already logged; still must"


def test_bulk_delete_clears_the_visits_and_logs_each_item(session_client, workspace, project, create_user, activity):
    first, second = _issue(project, "first"), _issue(project, "second")
    visits = [_visit(create_user, first, project), _visit(create_user, second, project)]

    response = session_client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(first.id), str(second.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert not any(_alive(visit) for visit in visits)
    assert sorted(_deleted_activity_ids(activity["app"])) == sorted([str(first.id), str(second.id)])


def test_app_intake_destroy_clears_the_visit_and_logs(
    session_client, workspace, project, intake, create_user, activity
):
    issue = _issue(project, "intake item", created_by=create_user)
    IntakeIssue.objects.create(
        intake=intake, issue=issue, project=project, workspace=project.workspace, status=-2, created_by=create_user
    )
    visit = _visit(create_user, issue, project)

    response = session_client.delete(APP_INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not Issue.objects.filter(pk=issue.pk).exists(), "sanity: status -2 deletes the work item"
    assert not _alive(visit)
    assert _deleted_activity_ids(activity["app_intake"]) == [str(issue.id)]
    _assert_log_shape(_deleted_activity_calls(activity["app_intake"])[0], issue, project)


def test_api_intake_delete_clears_the_visit_and_logs(api_key_client, workspace, project, intake, create_user, activity):
    issue = _issue(project, "v1 intake item", created_by=create_user)
    IntakeIssue.objects.create(
        intake=intake, issue=issue, project=project, workspace=project.workspace, status=-2, created_by=create_user
    )
    visit = _visit(create_user, issue, project)

    response = api_key_client.delete(API_INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not _alive(visit)
    assert _deleted_activity_ids(activity["api_intake"]) == [str(issue.id)]
    _assert_log_shape(_deleted_activity_calls(activity["api_intake"])[0], issue, project)


# --- the controls -------------------------------------------------------------------------------


def test_an_accepted_intake_item_keeps_its_visit_and_logs_nothing(
    session_client, workspace, project, intake, create_user, activity
):
    """status 1 (ACCEPTED) keeps the work item, so both cleanups must stay out of it. This is the
    one that would catch a cleanup hoisted out of the `issue is not None` branch."""
    issue = _issue(project, "accepted item", created_by=create_user)
    IntakeIssue.objects.create(
        intake=intake, issue=issue, project=project, workspace=project.workspace, status=1, created_by=create_user
    )
    visit = _visit(create_user, issue, project)

    response = session_client.delete(APP_INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert Issue.objects.filter(pk=issue.pk).exists(), "sanity: an accepted item lives on"
    assert _alive(visit), "so its recently-visited row must live on too"
    assert _deleted_activity_ids(activity["app_intake"]) == [], "and nothing was deleted to log"


def test_an_orphaned_intake_row_logs_nothing(session_client, workspace, project, intake, create_user, activity):
    """The APLANE-31 branch: the work item is already gone, so there is no deletion to log now."""
    issue = _issue(project, "orphaned item", created_by=create_user)
    IntakeIssue.objects.create(
        intake=intake, issue=issue, project=project, workspace=project.workspace, status=-2, created_by=create_user
    )
    Issue.all_objects.filter(pk=issue.pk).update(deleted_at="2026-01-01T00:00:00Z")

    response = session_client.delete(APP_INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert _deleted_activity_ids(activity["app_intake"]) == []


def test_another_work_items_visit_survives(session_client, workspace, project, create_user):
    doomed, survivor = _issue(project, "doomed"), _issue(project, "survivor")
    doomed_visit = _visit(create_user, doomed, project)
    survivor_visit = _visit(create_user, survivor, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=doomed.id))

    assert not _alive(doomed_visit)
    assert _alive(survivor_visit), "the cleanup must be keyed on the deleted id, not the project"


def test_every_users_visit_goes_not_just_the_callers(session_client, workspace, project, create_user):
    """Not caller-scoped, exactly as with the pins: the work item is gone for everybody."""
    issue = _issue(project)
    mine = _visit(create_user, issue, project)
    theirs = _visit(_other_member(workspace, project), issue, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert not _alive(mine)
    assert not _alive(theirs)


def test_a_row_for_the_same_id_in_another_project_survives(session_client, workspace, project, create_user):
    """The filter is project-scoped, so a row carrying this id under a different project stays.

    Contrived — an issue id is a UUID4 and lives in one project — but the scoping is deliberate
    and inherited from the original implementation, so it is pinned rather than left to a reader's
    assumption.
    """
    issue = _issue(project)
    other = Project.objects.create(name="Other", identifier=f"OT{uuid4().hex[:3]}", workspace=workspace)
    stray = UserRecentVisit.objects.create(
        user=create_user,
        entity_name="issue",
        entity_identifier=issue.id,
        project=other,
        workspace=workspace,
    )

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert _alive(stray)


def test_a_sub_items_visit_row_is_deliberately_left(session_client, workspace, project, create_user):
    """The documented deviation from the pin cleanup, pinned so it cannot change unnoticed.

    In PRODUCTION the child is soft-deleted by the celery cascade, so its row is dead afterwards
    and we leave it: a dead row never renders (`entity_data: null`, filtered by the home widget),
    it only displaces a live one in a 20-slot list, while a stale pin renders in the sidebar. In
    THIS test the cascade is patched out by the autouse fixture, so the child is still alive and
    all the assertion really proves is that the helper does not walk the sub-tree. That is the part
    worth pinning; the justification above is an argument, not a measurement. If someone decides to
    walk it here too, this is the test to delete, consciously.
    """
    parent = _issue(project, "parent")
    child = _issue(project, "child", parent_id=None)
    child.parent = parent
    child.save()
    child_visit = _visit(create_user, child, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=parent.id))

    assert _alive(child_visit)


def test_bulk_delete_logs_only_the_ids_it_actually_deleted(session_client, workspace, project, create_user, activity):
    """The invariant two comments in the endpoint claim and no test proved.

    `Issue.issue_objects` excludes archived, draft, triage and archived-project items, so an id in
    the request body is not necessarily an id that gets deleted. The loop and both cleanups are
    keyed on `deleted_ids`, read off the queryset before the delete — key them on the body instead
    and an archived work item that survives the request loses its visit row and gets a deletion
    logged against it. Same class as the pin bug an earlier audit found on this endpoint.
    """
    doomed = _issue(project, "doomed")
    archived = _issue(project, "archived")
    Issue.all_objects.filter(pk=archived.pk).update(archived_at="2026-01-01")  # DateField, not DateTime
    doomed_visit = _visit(create_user, doomed, project)
    archived_visit = _visit(create_user, archived, project)

    response = session_client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(doomed.id), str(archived.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK, response.data
    assert Issue.all_objects.filter(pk=archived.pk, deleted_at__isnull=True).exists(), (
        "sanity: issue_objects must have excluded the archived item, or this test proves nothing"
    )
    assert _deleted_activity_ids(activity["app"]) == [str(doomed.id)], "the archived item was not deleted"
    assert not _alive(doomed_visit)
    assert _alive(archived_visit), "it still exists, so it keeps its recently-visited row"
