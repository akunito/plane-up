# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A DELETE on the intake paths must not 500 when a row it dereferences is already gone (APLANE-31).

Three `.first()` results were dereferenced unguarded:

1. `IntakeIssueViewSet.destroy` / `IntakeIssueAPIEndpoint.delete` called `issue.delete()` on a work
   item that can be None. Reachable when an `IntakeIssue` row outlives its `Issue`: the soft delete
   cascades through celery's `soft_delete_related_objects`, which has no retry, only `print()`s a
   failed relation in its CASCADE branch (so there is no logged error to find afterwards), and dies
   outright on a failure in its SET_NULL branch, before the intake relation is reached.
2. `IntakeViewSet.destroy` read `intake.is_default` on a missing intake — any project member with a
   stale, foreign or already-deleted intake id got a 500 instead of a 404.
3. The external API's intake endpoints guard with `if intake is None and not project.intake_view`,
   so a missing intake row with intake_view still on fell through to `intake.id`. The two
   `get_queryset` guards in the same file use `or`, which is what the author meant.

None of these is permanent: `hard_delete` reaps work items `HARD_DELETE_AFTER_DAYS` (60) after the
soft delete and the FK cascade takes the intake row with it (`bgtasks/deletion_task.py:150`,
daily at 00:00 UTC, `celery.py:61-64`). So the bug is "undeletable for up to ~60 days", not for ever.

The happy paths are covered too, because each fix is a branch and a branch can be wrong on either
side. The pins half is deliberate: the orphan branch drops the stale pin with `cascade=False`, so a
sub-item that is still alive keeps its own.
"""

from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from django.utils import timezone

from plane.db.models import (
    Intake,
    IntakeIssue,
    Issue,
    Project,
    ProjectMember,
    State,
    User,
    UserFavorite,
    WorkspaceMember,
)

pytestmark = pytest.mark.contract

APP_URL = "/api/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"
APP_CREATE_URL = "/api/workspaces/{slug}/projects/{project_id}/intake-issues/"
API_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"
API_CREATE_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/intake-issues/"
INTAKE_URL = "/api/workspaces/{slug}/projects/{project_id}/intakes/{pk}/"


@pytest.fixture(autouse=True)
def _no_broker(db):
    """`intake_issue.delete()` is an instance delete and queues the cascade; there is no broker."""
    with mock.patch("plane.db.mixins.soft_delete_related_objects") as cascade:
        yield cascade


@pytest.fixture
def project(workspace, create_user):
    created = Project.objects.create(
        name="Intake orphan", identifier=f"IO{uuid4().hex[:3]}", workspace=workspace, intake_view=True
    )
    ProjectMember.objects.create(workspace=workspace, project=created, member=create_user, role=20)
    # Project.save() seeds no states (only the create VIEW does), and without one
    # Issue._ensure_default_state leaves state_id NULL, which breaks anything reading state.group.
    State.objects.create(
        name="Triage", group="triage", color="#60646C", default=True, project=created, workspace=workspace
    )
    return created


@pytest.fixture
def intake(project):
    return Intake.objects.create(name="Intake", project=project, workspace=project.workspace, is_default=True)


def _issue(project, name="intake item", **kwargs):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, **kwargs)


def _intake_issue(intake, issue, status_code=-2, user=None):
    return IntakeIssue.objects.create(
        intake=intake,
        issue=issue,
        project=issue.project,
        workspace=issue.workspace,
        status=status_code,
        created_by=user,
    )


def _pin(user, issue, project):
    return UserFavorite.objects.create(
        user=user,
        entity_type="issue",
        entity_identifier=issue.id,
        project=project,
        workspace=project.workspace,
        name="STALE LABEL",
    )


def _alive(pin):
    """UserFavorite soft-deletes, so `objects` (deleted_at IS NULL) is what the sidebar lists."""
    return UserFavorite.objects.filter(pk=pin.pk).exists()


def _orphan(intake, project, user, status_code=-2):
    """An IntakeIssue whose work item is soft-deleted and whose cascade never ran.

    The `update()` is the point: a bare `UPDATE ... SET deleted_at` is exactly what a lost
    `soft_delete_related_objects` leaves behind, and it does not touch the intake row.
    """
    issue = _issue(project, "orphaned item", created_by=user)
    _intake_issue(intake, issue, status_code, user)
    Issue.all_objects.filter(pk=issue.pk).update(deleted_at=timezone.now())
    assert not Issue.objects.filter(pk=issue.pk).exists(), "sanity: the work item must look deleted"
    assert IntakeIssue.objects.filter(issue_id=issue.pk).exists(), (
        "sanity: the intake row must have OUTLIVED it, or the view 404s and this test proves nothing"
    )
    return issue


def _intake_row_gone(issue):
    return not IntakeIssue.objects.filter(issue_id=issue.pk).exists()


def _member(workspace, project):
    """A plain project MEMBER: not an admin anywhere, so the admin arms cannot save them."""
    user = User.objects.create(email=f"bob-{uuid4().hex[:8]}@plane.so", username=f"bob_{uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=15)
    return user


# --- 1a. an orphaned intake row, app path -------------------------------------------------------


@pytest.mark.parametrize("status_code", [-2, -1, 0, 2])
def test_app_destroy_of_an_orphaned_intake_row_succeeds(
    session_client, workspace, project, intake, create_user, status_code
):
    """Every status that deletes the work item takes the same branch, so pin all four."""
    issue = _orphan(intake, project, create_user, status_code)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert _intake_row_gone(issue), "the orphan row must be deletable — being stuck is the whole bug"


def test_app_destroy_of_an_orphaned_row_drops_the_stale_pin(session_client, workspace, project, intake, create_user):
    issue = _orphan(intake, project, create_user)
    pin = _pin(create_user, issue, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert not _alive(pin), "the work item is gone, so the pin pointing at it must go"


def test_app_destroy_of_an_orphaned_row_keeps_a_live_sub_items_pin(
    session_client, workspace, project, intake, create_user
):
    """Why the orphan branch passes `cascade=False`: nothing is deleted in it, and the children of
    an already-deleted parent may still be alive precisely because that cascade is what failed."""
    issue = _orphan(intake, project, create_user)
    child = _issue(project, "live sub-item", parent_id=issue.pk)
    child_pin = _pin(create_user, child, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert Issue.objects.filter(pk=child.pk).exists(), (
        "sanity: the sub-item is still alive, which is what makes its pin correct to keep"
    )
    assert _alive(child_pin), "a pin must not vanish from a work item the user can still open"


def test_app_destroy_of_an_orphaned_row_still_needs_admin(session_client, workspace, project, intake):
    """The behaviour this fix deliberately does NOT change, pinned so it cannot drift silently.

    `allow_permission(..., creator=True, model=Issue)` resolves the creator arm through
    `Issue.objects`, which excludes soft-deleted rows, so the creator of an orphaned item cannot
    satisfy it and falls back to the ADMIN role check. Widening that would mean reading
    `all_objects` purely to grant a delete — a permission change dressed as a bug fix. The external
    path is structurally identical: its creator arm is `issue is not None and issue.created_by_id
    == request.user.id`.
    """
    bob = _member(workspace, project)
    issue = _orphan(intake, project, bob)
    session_client.force_authenticate(user=bob)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    assert not _intake_row_gone(issue)


def test_app_destroy_still_deletes_a_live_work_item(session_client, workspace, project, intake, create_user):
    """The control: the guard must not turn the normal path into a no-op."""
    issue = _issue(project, "live intake item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    pin = _pin(create_user, issue, project)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not Issue.objects.filter(pk=issue.pk).exists(), "status -2 means the work item goes too"
    assert _intake_row_gone(issue)
    assert not _alive(pin)


def test_app_destroy_of_an_accepted_row_never_touches_the_work_item(
    session_client, workspace, project, intake, create_user
):
    """status 1 (ACCEPTED) is not in the delete list, so the work item survives — and its pin must.

    This is here because the fix touches the branch that decides whether to delete, and a guard
    placed one level too high would quietly start deleting accepted items' work items.
    """
    issue = _issue(project, "accepted item", created_by=create_user)
    _intake_issue(intake, issue, 1, create_user)
    pin = _pin(create_user, issue, project)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert Issue.objects.filter(pk=issue.pk).exists(), "an accepted item lives on as a normal work item"
    assert _alive(pin), "so it keeps its pin"
    assert _intake_row_gone(issue)


# --- 1b. an orphaned intake row, external API path ----------------------------------------------


def test_api_destroy_of_an_orphaned_intake_row_succeeds(api_key_client, workspace, project, intake, create_user):
    issue = _orphan(intake, project, create_user)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert _intake_row_gone(issue)


def test_api_destroy_of_an_orphaned_row_drops_the_stale_pin(api_key_client, workspace, project, intake, create_user):
    issue = _orphan(intake, project, create_user)
    pin = _pin(create_user, issue, project)

    api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert not _alive(pin)


def test_api_destroy_of_an_orphaned_row_keeps_a_live_sub_items_pin(
    api_key_client, workspace, project, intake, create_user
):
    issue = _orphan(intake, project, create_user)
    child = _issue(project, "live sub-item", parent_id=issue.pk)
    child_pin = _pin(create_user, child, project)

    api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert Issue.objects.filter(pk=child.pk).exists()
    assert _alive(child_pin)


def test_api_destroy_still_deletes_a_live_work_item(api_key_client, workspace, project, intake, create_user):
    issue = _issue(project, "live v1 intake item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    pin = _pin(create_user, issue, project)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert not Issue.objects.filter(pk=issue.pk).exists()
    assert _intake_row_gone(issue)
    assert not _alive(pin)


def test_api_destroy_of_an_accepted_row_never_touches_the_work_item(
    api_key_client, workspace, project, intake, create_user
):
    issue = _issue(project, "accepted v1 item", created_by=create_user)
    _intake_issue(intake, issue, 1, create_user)
    pin = _pin(create_user, issue, project)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert Issue.objects.filter(pk=issue.pk).exists()
    assert _alive(pin)


# --- 2. a missing INTAKE row, app path ----------------------------------------------------------
# Found auditing the fix above: the same shape, in the same file, and far easier to reach — no lost
# celery task needed, just an id that no longer resolves.


def test_deleting_an_unknown_intake_is_404_not_500(session_client, workspace, project):
    response = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=uuid4()))

    assert response.status_code == status.HTTP_404_NOT_FOUND, response.data


def test_deleting_an_intake_of_another_project_is_404(session_client, workspace, project, create_user):
    other = Project.objects.create(
        name="Other", identifier=f"OT{uuid4().hex[:3]}", workspace=workspace, intake_view=True
    )
    ProjectMember.objects.create(workspace=workspace, project=other, member=create_user, role=20)
    foreign = Intake.objects.create(name="Foreign", project=other, workspace=workspace, is_default=True)

    response = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=foreign.id))

    assert response.status_code == status.HTTP_404_NOT_FOUND, response.data
    assert Intake.objects.filter(pk=foreign.pk).exists(), "and it must not be deleted through the wrong project"


def test_deleting_an_already_deleted_intake_is_404(session_client, workspace, project):
    """The repeat DELETE: the first one soft-deletes the row, so the second finds nothing."""
    extra = Intake.objects.create(name="Extra", project=project, workspace=project.workspace, is_default=False)

    first = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=extra.id))
    second = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=extra.id))

    assert first.status_code == status.HTTP_204_NO_CONTENT, first.data
    assert second.status_code == status.HTTP_404_NOT_FOUND, second.data


def test_the_default_intake_still_cannot_be_deleted(session_client, workspace, project, intake):
    """The control for the guard above: the 400 must still come from is_default, not from the 404."""
    response = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=intake.id))

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert Intake.objects.filter(pk=intake.pk).exists()


# --- 3. a missing intake row with intake_view still on, external API path -----------------------
# `if intake is None and not project.intake_view` never fires when intake_view is on, so the next
# line's `intake.id` raised. Reachable with the same failed cascade: the intake row itself is a
# soft-deletable row that can go while the IntakeIssue rows under it survive.


def _intake_row_soft_deleted(intake):
    Intake.all_objects.filter(pk=intake.pk).update(deleted_at=timezone.now())
    assert not Intake.objects.filter(pk=intake.pk).exists(), "sanity: the intake must look deleted"


def test_api_delete_with_a_soft_deleted_intake_is_400_not_500(api_key_client, workspace, project, intake, create_user):
    issue = _issue(project, "stranded item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    _intake_row_soft_deleted(intake)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert "Intake is not enabled" in str(response.data), response.data


def test_api_create_with_a_soft_deleted_intake_is_400_not_500(api_key_client, workspace, project, intake):
    _intake_row_soft_deleted(intake)

    response = api_key_client.post(
        API_CREATE_URL.format(slug=workspace.slug, project_id=project.id),
        {"issue": {"name": "nowhere to put this"}},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert "Intake is not enabled" in str(response.data), response.data


def test_api_patch_with_a_soft_deleted_intake_is_400_not_500(api_key_client, workspace, project, intake, create_user):
    issue = _issue(project, "stranded item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    _intake_row_soft_deleted(intake)

    response = api_key_client.patch(
        API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id),
        {"issue": {"name": "renamed"}},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert "Intake is not enabled" in str(response.data), response.data


def test_app_paths_still_404_when_the_intake_row_is_gone(session_client, workspace, project, intake, create_user):
    """The app path has no intake-enabled guard at all: `intake_id=None` simply makes its `.get()`
    raise DoesNotExist, which the base view maps to 404. Nothing to fix, worth pinning."""
    issue = _issue(project, "stranded item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    _intake_row_soft_deleted(intake)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_404_NOT_FOUND, response.data


def test_api_delete_still_works_with_intake_view_off_but_the_row_alive(
    api_key_client, workspace, project, intake, create_user
):
    """The behaviour the narrow guard preserves, and the regression a wider one caused.

    Rewriting the guard as `intake is None or not project.intake_view` (which is what `get_queryset`
    uses) looks like the obvious tidy-up and breaks this: a project whose intake_view was switched
    off keeps its intake row, and the endpoint has always served it. The full suite caught it.
    """
    issue = _issue(project, "legacy intake item", created_by=create_user)
    _intake_issue(intake, issue, -2, create_user)
    Project.objects.filter(pk=project.pk).update(intake_view=False)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    assert _intake_row_gone(issue)
