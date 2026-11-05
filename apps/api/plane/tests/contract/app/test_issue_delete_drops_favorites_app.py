# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deleting a work item drops the sidebar pins that point at it, server-side (APLANE-29, B-10).

Cycles, modules, projects and pages all clear their UserFavorite rows in their own destroy.
Work items did not: the only cleanup was client-side, in usePinnedEntities' SWR fetcher, which
fires a DELETE once it resolves the pin and gets a 404. So the row survived the delete until some
browser happened to render that sidebar — and the E2E assertion ("the favourites were removed
server-side") was racing that fetch, which is what made sidebar.spec.ts:236 flaky on every project
rather than only on WebKit. (The leftover row's `entity_data: null` is NOT evidence of the pin being
hidden: get_entity_data maps "issue" to (Issue, None), so it is null for every issue favourite,
alive or dead.)

Pins are shared across users for the same entity, so the cleanup is deliberately NOT scoped to the
caller: the work item is gone for everybody. Archiving is the documented exception and is pinned
here too, so this fix cannot quietly grow into it.
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

APP_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{pk}/"
INTAKE_URL = "/api/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"
API_INTAKE_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/intake-issues/{pk}/"
APP_ARCHIVE_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{pk}/archive/"
BULK_URL = "/api/workspaces/{slug}/projects/{project_id}/bulk-delete-issues/"
API_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/issues/{pk}/"


@pytest.fixture(autouse=True)
def _no_broker(db):
    """The delete paths fan out to celery; the tests only care about the rows left behind."""
    with (
        mock.patch("plane.db.mixins.soft_delete_related_objects"),
        mock.patch("plane.app.views.issue.base.issue_activity"),
        mock.patch("plane.app.views.issue.archive.issue_activity"),
        mock.patch("plane.api.views.issue.issue_activity"),
    ):
        yield


@pytest.fixture
def project(workspace, create_user):
    created = Project.objects.create(name="Pinned", identifier="PIN", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=created, member=create_user, role=20)
    # Only the project CREATE VIEW seeds DEFAULT_STATES; Project.save() does not and there is no
    # signal. Without a state, Issue._ensure_default_state leaves state_id NULL and anything that
    # reads issue.state.group raises AttributeError before the request is even made.
    State.objects.create(
        name="Done", group="completed", color="#60646C", sequence=45000, default=True,
        project=created, workspace=workspace,
    )
    return created


def _issue(project, name="pinned item"):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace)


def _child(project, parent, name="sub item"):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, parent=parent)


def _archived_issue(project, name="archived item"):
    """Archived via a direct UPDATE: it is what issue_objects excludes, with no save() side effects."""
    issue = _issue(project, name)
    Issue.all_objects.filter(pk=issue.pk).update(archived_at=timezone.now())
    return issue


def _pin(user, issue, project):
    return UserFavorite.objects.create(
        user=user,
        entity_type="issue",
        entity_identifier=issue.id,
        project=project,
        workspace=project.workspace,
        name="STALE LABEL",
    )


def _other_member(workspace, project):
    user = User.objects.create(email=f"bob-{uuid4().hex[:8]}@plane.so", username=f"bob_{uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=20)
    ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=20)
    return user


def _alive(pin):
    """UserFavorite is soft-deleted, so `objects` (deleted_at IS NULL) is the list the sidebar sees."""
    return UserFavorite.objects.filter(pk=pin.pk).exists()


def test_destroy_drops_the_pin(session_client, workspace, project, create_user):
    issue = _issue(project)
    pin = _pin(create_user, issue, project)

    response = session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert not _alive(pin), "the favourite outlived the work item it points at"


def test_destroy_drops_every_user_s_pin_not_just_the_caller_s(session_client, workspace, project, create_user):
    issue = _issue(project)
    mine = _pin(create_user, issue, project)
    theirs = _pin(_other_member(workspace, project), issue, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert not _alive(mine)
    assert not _alive(theirs), "the work item is gone for everyone, so every pin to it must go"


def test_destroy_leaves_other_work_items_pins_alone(session_client, workspace, project, create_user):
    doomed = _issue(project, "doomed")
    survivor = _issue(project, "survivor")
    doomed_pin = _pin(create_user, doomed, project)
    survivor_pin = _pin(create_user, survivor, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=doomed.id))

    assert not _alive(doomed_pin)
    assert _alive(survivor_pin), "the cleanup must be keyed on the deleted id, not the project"


def test_archiving_keeps_the_pin(session_client, workspace, project, create_user):
    """The documented deviation from pages (pinned by L4-03b): an archived work item keeps its pin."""
    issue = _issue(project)  # the fixture's default state is already "completed", so it can archive
    pin = _pin(create_user, issue, project)

    response = session_client.post(APP_ARCHIVE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_200_OK
    assert _alive(pin), "archiving must keep the pin — it opens the archived route"


def test_bulk_delete_drops_the_pins_of_every_deleted_item(session_client, workspace, project, create_user):
    first, second = _issue(project, "first"), _issue(project, "second")
    survivor = _issue(project, "survivor")
    pins = [_pin(create_user, first, project), _pin(create_user, second, project)]
    survivor_pin = _pin(create_user, survivor, project)

    response = session_client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(first.id), str(second.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert not any(_alive(pin) for pin in pins)
    assert _alive(survivor_pin), "the cleanup must be keyed on the deleted ids, not the project"


def test_bulk_delete_keeps_the_pin_of_an_archived_id_it_does_not_delete(
    session_client, workspace, project, create_user
):
    """Issue.issue_objects excludes archived items, so an archived id in the body is NOT deleted —
    and its pin must survive (L4-03b). Keying the cleanup on the raw request body got this wrong."""
    archived = _archived_issue(project)
    pin = _pin(create_user, archived, project)

    response = session_client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(archived.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert Issue.all_objects.filter(pk=archived.pk, deleted_at__isnull=True).exists(), (
        "sanity: issue_objects must have excluded the archived item, or this test proves nothing"
    )
    assert _alive(pin), "an archived work item survives the bulk delete, so its pin must too"


def test_external_api_delete_drops_the_pin(api_key_client, workspace, project, create_user):
    issue = _issue(project)
    issue.created_by = create_user  # the external endpoint allows the creator or an admin
    issue.save()
    pin = _pin(create_user, issue, project)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert not _alive(pin), "the v1 endpoint deletes the same work item and must clean up the same rows"


# --- sub-items (APLANE-29 follow-up) -------------------------------------------------------------
# Issue.parent is CASCADE and Issue.objects is the plain soft-delete manager, so deleting a work
# item soft-deletes its whole sub-tree. Nothing cleared those children's pins, so the original fix
# left the same stale-row bug one level down.


def test_destroy_drops_a_sub_items_pin(session_client, workspace, project, create_user):
    parent = _issue(project, "parent")
    child = _child(project, parent)
    parent_pin = _pin(create_user, parent, project)
    child_pin = _pin(create_user, child, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=parent.id))

    assert not _alive(parent_pin)
    assert not _alive(child_pin), "the cascade soft-deletes the sub-item, so its pin must go too"


def test_destroy_walks_more_than_one_level_of_sub_items(session_client, workspace, project, create_user):
    parent = _issue(project, "parent")
    child = _child(project, parent, "child")
    grandchild = _child(project, child, "grandchild")
    pins = [_pin(create_user, item, project) for item in (parent, child, grandchild)]

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=parent.id))

    assert not any(_alive(pin) for pin in pins), "the walk must follow the whole sub-tree, not one level"


def test_destroy_drops_an_archived_sub_items_pin(session_client, workspace, project, create_user):
    """Archiving an item keeps its pin, but deleting its PARENT takes the pin with it.

    What this actually asserts is that the WALK does not skip archived children. It cannot assert
    that the cascade soft-deletes them, because `_no_broker` patches `soft_delete_related_objects`
    out. That half is an argument, not a measurement: `soft_delete_related_objects` reaches children
    via `(manager="objects")`, and `Issue.objects` is the plain `SoftDeletionManager`, which filters
    `deleted_at` only — so archived and draft children are included. If upstream ever points
    `Issue.objects` at `IssueManager`, that argument breaks and nothing here will notice."""
    parent = _issue(project, "parent")
    child = _child(project, parent, "archived child")
    Issue.all_objects.filter(pk=child.pk).update(archived_at=timezone.now())
    child_pin = _pin(create_user, child, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=parent.id))

    assert not _alive(child_pin)


def test_destroy_leaves_a_sibling_subtree_alone(session_client, workspace, project, create_user):
    doomed = _issue(project, "doomed parent")
    _child(project, doomed, "doomed child")
    survivor = _issue(project, "survivor parent")
    survivor_child = _child(project, survivor, "survivor child")
    survivor_pin = _pin(create_user, survivor_child, project)

    session_client.delete(APP_URL.format(slug=workspace.slug, project_id=project.id, pk=doomed.id))

    assert _alive(survivor_pin), "the walk must not escape the deleted sub-tree"


# --- intake (APLANE-29 follow-up) ----------------------------------------------------------------


def test_intake_destroy_drops_the_pin(session_client, workspace, project, create_user):
    """The intake destroy deletes the work item itself when the item was never accepted, and had
    no pin cleanup of its own."""
    intake = Intake.objects.create(name="Intake", project=project, workspace=workspace, is_default=True)
    issue = _issue(project, "intake item")
    IntakeIssue.objects.create(intake=intake, issue=issue, project=project, workspace=workspace, status=-2)
    pin = _pin(create_user, issue, project)

    response = session_client.delete(INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert not Issue.objects.filter(pk=issue.pk).exists(), "sanity: status -2 means the item is deleted too"
    assert not _alive(pin)


def test_bulk_delete_keeps_a_live_sub_items_pin(session_client, workspace, project, create_user):
    """The regression this test exists for: the bulk endpoint uses the QUERYSET delete, which is a
    bare `update(deleted_at=…)` and never queues `soft_delete_related_objects`. So sub-items of a
    bulk-deleted parent stay alive and listable, and their pins must stay too — otherwise a pin
    disappears from a work item the user can still open."""
    parent = _issue(project, "bulk parent")
    child = _child(project, parent)
    parent_pin = _pin(create_user, parent, project)
    child_pin = _pin(create_user, child, project)

    response = session_client.delete(
        BULK_URL.format(slug=workspace.slug, project_id=project.id),
        data={"issue_ids": [str(parent.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert not _alive(parent_pin)
    assert Issue.objects.filter(pk=child.pk).exists(), (
        "sanity: the queryset delete does not cascade, so the sub-item must still be alive — "
        "if this fails the premise of the test is gone"
    )
    assert _alive(child_pin), "the sub-item is still there, so it must keep its pin"


def test_api_intake_destroy_drops_the_pin(api_key_client, workspace, project, create_user):
    """The v1 intake destroy — the one call site with no coverage until now."""
    intake = Intake.objects.create(name="Intake", project=project, workspace=workspace, is_default=True)
    issue = _issue(project, "v1 intake item")
    issue.created_by = create_user  # the endpoint allows the creator or an admin
    issue.save()
    IntakeIssue.objects.create(
        intake=intake, issue=issue, project=project, workspace=workspace, status=-2, created_by=create_user
    )
    pin = _pin(create_user, issue, project)

    response = api_key_client.delete(API_INTAKE_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert not Issue.objects.filter(pk=issue.pk).exists(), "sanity: status -2 means the item is deleted too"
    assert not _alive(pin)
