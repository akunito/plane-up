# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract: a work item CREATED through the external API must subscribe its assignees (APLANE-5).

Plane notifies subscribers and excludes the actor, and assigning does not notify directly — it
works because ``track_assignees`` adds an ``IssueSubscriber`` row for each new assignee. On the
create path that only ran when the payload carried ``assignee_ids``, the app API's field name,
while the external API sends ``assignees``. So an item created through ``/api/v1/...`` with
assignees ended up with the actor as its only subscriber and notified nobody — which is why
tickets created by n8n and the MCP landed silently, while the Telegram bot's ``/assign`` (a PATCH,
and ``update_issue_activity`` already mapped both names) worked all along.

These tests call ``create_issue_activity`` for real instead of mocking ``issue_activity``.
test_issue_notifications.py mocks it and asserts only that the task was dispatched with
notification=True, which is why it stayed green while this was broken: the gap was inside the task.
"""

import json
from uuid import uuid4

import pytest

from plane.bgtasks.issue_activities_task import create_issue_activity
from plane.db.models import Issue, IssueActivity, IssueSubscriber, Project, ProjectMember, State, User


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Notify Project", identifier="NP", workspace=workspace, created_by=create_user
    )
    ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
    State.objects.create(
        name="Backlog",
        color="#000000",
        group="backlog",
        default=True,
        project=project,
        workspace=workspace,
        created_by=create_user,
    )
    return project


def _member(workspace, project, *, role=15, active=True):
    unique = uuid4().hex[:8]
    user = User.objects.create(email=f"assignee-{unique}@plane.so", username=f"assignee_{unique}")
    ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=role, is_active=active)
    return user


@pytest.fixture
def issue(db, project, workspace, create_user):
    return Issue.objects.create(name="Created by an automation", project=project, workspace=workspace, created_by=create_user)


def _run_create_activity(payload, issue, project, workspace, actor):
    """Run the create-activity task body the way issue_activity does, synchronously."""
    activities = []
    create_issue_activity(
        requested_data=json.dumps(payload),
        current_instance=None,
        issue_id=str(issue.id),
        project_id=str(project.id),
        workspace_id=str(workspace.id),
        actor_id=str(actor.id),
        issue_activities=activities,
        epoch=0,
    )
    return activities


def _subscribers(issue):
    return set(IssueSubscriber.objects.filter(issue=issue).values_list("subscriber_id", flat=True))


@pytest.mark.contract
@pytest.mark.django_db
class TestCreateSubscribesAssignees:
    def test_external_api_field_name_subscribes_the_assignee(self, issue, project, workspace, create_user):
        """`assignees` is what /api/v1/ sends. This is the case that was broken."""
        assignee = _member(workspace, project)

        _run_create_activity({"name": issue.name, "assignees": [str(assignee.id)]}, issue, project, workspace, create_user)

        assert assignee.id in _subscribers(issue)

    def test_app_api_field_name_still_subscribes_the_assignee(self, issue, project, workspace, create_user):
        """Regression guard for the path that already worked."""
        assignee = _member(workspace, project)

        _run_create_activity(
            {"name": issue.name, "assignee_ids": [str(assignee.id)]}, issue, project, workspace, create_user
        )

        assert assignee.id in _subscribers(issue)

    def test_it_records_the_added_assignee_activity(self, issue, project, workspace, create_user):
        """The subscriber row is what notifies; the activity row is what the feed shows."""
        assignee = _member(workspace, project)

        activities = _run_create_activity(
            {"name": issue.name, "assignees": [str(assignee.id)]}, issue, project, workspace, create_user
        )

        assert any(a.field == "assignees" and str(a.new_identifier) == str(assignee.id) for a in activities)

    def test_a_payload_without_assignees_subscribes_nobody(self, issue, project, workspace, create_user):
        _run_create_activity({"name": issue.name}, issue, project, workspace, create_user)

        assert _subscribers(issue) == set()

    def test_an_assignee_who_is_not_an_active_member_is_ignored(self, issue, project, workspace, create_user):
        """Same rule as IssueCreateSerializer: active project members with role >= MEMBER."""
        outsider = _member(workspace, project, active=False)
        guest = _member(workspace, project, role=5)

        _run_create_activity(
            {"name": issue.name, "assignees": [str(outsider.id), str(guest.id)]},
            issue,
            project,
            workspace,
            create_user,
        )

        assert _subscribers(issue) == set()

    def test_running_it_twice_does_not_duplicate_the_subscription(self, issue, project, workspace, create_user):
        """The task can be retried by celery; a second run must not raise or double-insert."""
        assignee = _member(workspace, project)
        payload = {"name": issue.name, "assignees": [str(assignee.id)]}

        _run_create_activity(payload, issue, project, workspace, create_user)
        _run_create_activity(payload, issue, project, workspace, create_user)

        assert IssueSubscriber.objects.filter(issue=issue, subscriber=assignee).count() == 1

    def test_the_activity_row_for_the_creation_itself_is_still_written(self, issue, project, workspace, create_user):
        """Widening the guard must not disturb what create_issue_activity already did."""
        _run_create_activity({"name": issue.name}, issue, project, workspace, create_user)

        assert IssueActivity.objects.filter(issue=issue, verb="created").exists()
