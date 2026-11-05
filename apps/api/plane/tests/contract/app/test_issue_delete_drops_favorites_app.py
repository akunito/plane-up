# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deleting a work item drops the sidebar pins that point at it, server-side (APLANE-29, B-10).

Cycles, modules, projects and pages all clear their UserFavorite rows in their own destroy.
Work items did not: the only cleanup was client-side, in usePinnedEntities' SWR fetcher, which
fires a DELETE once it resolves the pin and gets a 404. So the row survived the delete until some
browser happened to render that sidebar — and the E2E assertion ("the favourites were removed
server-side") was racing that fetch, which is what made sidebar.spec.ts:236 flaky on every project
rather than only on WebKit.

Pins are shared across users for the same entity, so the cleanup is deliberately NOT scoped to the
caller: the work item is gone for everybody. Archiving is the documented exception and is pinned
here too, so this fix cannot quietly grow into it.
"""

from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import Issue, Project, ProjectMember, User, UserFavorite, WorkspaceMember

APP_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{pk}/"
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
    return created


def _issue(project, name="pinned item"):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace)


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
    issue = _issue(project)
    issue.state.group = "completed"  # only a completed / cancelled item can be archived
    issue.state.save()
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
    assert _alive(survivor_pin)


def test_external_api_delete_drops_the_pin(api_key_client, workspace, project, create_user):
    issue = _issue(project)
    issue.created_by = create_user  # the external endpoint allows the creator or an admin
    issue.save()
    pin = _pin(create_user, issue, project)

    response = api_key_client.delete(API_URL.format(slug=workspace.slug, project_id=project.id, pk=issue.id))

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert not _alive(pin), "the v1 endpoint deletes the same work item and must clean up the same rows"
