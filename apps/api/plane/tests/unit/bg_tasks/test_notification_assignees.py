# L2 (APLANE-15, A-09): assignees are notified, not only explicit subscribers.
#
# v1.4.1 subscribes an assignee at the moment of assignment, so this only shows up for an
# assignee who then unsubscribed — which is exactly the case that used to go silent. Lived
# as a sed patch at container start until APLANE-15 put it in the source.

import json
import uuid

import pytest

from plane.db.models import (
    Issue,
    IssueAssignee,
    IssueSubscriber,
    Notification,
    ProjectMember,
    State,
    UserNotificationPreference,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


@pytest.fixture
def scenario(db):
    """An issue with an actor who changes it and an assignee who is NOT subscribed."""
    # username is unique and the factory leaves it empty, so two users in one test collide
    actor = UserFactory(username=f"actor-{uuid.uuid4().hex[:8]}")
    assignee = UserFactory(username=f"assignee-{uuid.uuid4().hex[:8]}")
    for user in (actor, assignee):
        UserNotificationPreference.objects.get_or_create(user=user)

    workspace = WorkspaceFactory(owner=actor)
    project = ProjectFactory(workspace=workspace, identifier=f"Q{uuid.uuid4().hex[:4].upper()}")
    for user in (actor, assignee):
        WorkspaceMemberFactory(workspace=workspace, member=user)
        ProjectMemberFactory(project=project, member=user, is_active=True)

    state = State.objects.create(name="In Progress", group="started", project=project, workspace=workspace)
    issue = Issue.objects.create(name="QAA case", project=project, workspace=workspace, state=state, created_by=actor)
    IssueAssignee.objects.create(issue=issue, assignee=assignee, project=project, workspace=workspace)
    # the point of the test: assigned, but not subscribed
    IssueSubscriber.objects.filter(issue=issue, subscriber=assignee).delete()
    return {"actor": actor, "assignee": assignee, "issue": issue, "project": project}


def run_notifications(scenario, **overrides):
    from plane.bgtasks.notification_task import notifications

    issue, project, actor = scenario["issue"], scenario["project"], scenario["actor"]
    activity = {
        "id": str(uuid.uuid4()),
        "issue_detail": {"id": str(issue.id), "name": issue.name},
        "field": "priority",
        "verb": "updated",
        "comment": "updated the priority",
        "actor_id": str(actor.id),
        "new_value": "urgent",
        "old_value": "none",
        "issue_comment": None,
        "new_identifier": None,
        "old_identifier": None,
    }
    activity.update(overrides)
    notifications(
        type="issue.activity.updated",
        issue_id=str(issue.id),
        project_id=str(project.id),
        actor_id=str(actor.id),
        subscriber=False,
        issue_activities_created=json.dumps([activity]),
        requested_data=json.dumps({"priority": "urgent"}),
        current_instance=json.dumps({"priority": "none"}),
    )


def notifications_for(user, issue):
    return Notification.objects.filter(receiver=user, entity_identifier=issue.id)


@pytest.mark.unit
@pytest.mark.django_db
class TestAssigneeNotifications:
    def test_unsubscribed_assignee_is_notified(self, scenario):
        run_notifications(scenario)
        assert notifications_for(scenario["assignee"], scenario["issue"]).count() == 1

    def test_the_actor_is_never_notified_of_their_own_change(self, scenario):
        run_notifications(scenario)
        assert notifications_for(scenario["actor"], scenario["issue"]).count() == 0

    def test_an_assignee_notified_once_even_when_also_subscribed(self, scenario):
        issue, project = scenario["issue"], scenario["project"]
        IssueSubscriber.objects.create(
            issue=issue, subscriber=scenario["assignee"], project=project, workspace=project.workspace
        )
        run_notifications(scenario)
        assert notifications_for(scenario["assignee"], issue).count() == 1

    def test_a_non_member_assignee_is_not_notified(self, scenario):
        # the subscriber/assignee sets are both scoped to active project members
        ProjectMember.objects.filter(project=scenario["project"], member=scenario["assignee"]).update(is_active=False)
        run_notifications(scenario)
        assert notifications_for(scenario["assignee"], scenario["issue"]).count() == 0

    def test_description_updates_stay_silent(self, scenario):
        run_notifications(scenario, field="description")
        assert notifications_for(scenario["assignee"], scenario["issue"]).count() == 0
