# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""APLANE-56: deleting a work item sends the `issue`/`deleted` webhook.

v1.4.1 sent issue webhooks only through model_activity (created/updated), so n8n's "Plane to
Google Calendar" never heard of a delete and the item's calendar event stayed forever (measured on
prod 2026-11-13: no delivery to n8n or plane-bot after deleting HOME-36). The n8n flow already
handles the payload: no target_date -> its If is false -> DELETE event <id without dashes>.
"""

import json
from unittest import mock

import pytest
from django.utils import timezone

from plane.bgtasks.deletion_task import soft_delete_related_objects
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.webhook_task import webhook_activity, webhook_send_task
from plane.db.models import Issue, IssueActivity, Project, ProjectMember, State, Webhook

pytestmark = pytest.mark.unit

TASK = "plane.bgtasks.issue_activities_task"


@pytest.fixture
def item(db, workspace, create_user):
    project = Project.objects.create(name="Home", identifier="HOME", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return Issue.objects.create(
        name="Dated item", project=project, workspace=workspace, target_date=timezone.now().date()
    )


def _activity(item, user, type, requested_data, current_instance="{}", origin="http://testserver"):
    issue_activity(
        type=type,
        requested_data=json.dumps(requested_data),
        current_instance=current_instance,
        issue_id=str(item.id),
        actor_id=str(user.id),
        project_id=str(item.project_id),
        epoch=int(timezone.now().timestamp()),
        origin=origin,
    )


def test_delete_activity_dispatches_the_deleted_issue_webhook(item, create_user, workspace):
    item.delete()  # every view soft-deletes BEFORE queueing the activity
    with mock.patch(f"{TASK}.webhook_activity") as hook, mock.patch(f"{TASK}.redis_instance"):
        _activity(item, create_user, "issue.activity.deleted", {"issue_id": str(item.id)})
    hook.delay.assert_called_once()
    kw = hook.delay.call_args.kwargs
    assert kw["event"] == "issue"
    assert kw["verb"] == "deleted"
    assert kw["event_id"] == str(item.id)
    assert kw["slug"] == workspace.slug
    assert kw["actor_id"] == str(create_user.id)
    assert kw["current_site"] == "http://testserver"


@pytest.mark.parametrize(
    "type,requested_data,current_instance",
    [
        ("issue.activity.updated", {"name": "Renamed"}, json.dumps({"name": "Dated item"})),
        ("issue.activity.created", {}, None),
        ("comment.activity.created", {"comment_html": "<p>x</p>"}, None),
    ],
)
def test_other_activities_send_no_webhook_from_this_task(item, create_user, type, requested_data, current_instance):
    # created/updated webhooks come from model_activity in the views; this task must not add a second one
    before = IssueActivity.objects.count()
    with mock.patch(f"{TASK}.webhook_activity") as hook, mock.patch(f"{TASK}.redis_instance"):
        _activity(item, create_user, type, requested_data, current_instance)
    # the task ran to the end (an exception swallowed by its try/except would also leave hook unused)
    assert IssueActivity.objects.count() > before
    hook.delay.assert_not_called()


def test_delete_reaches_n8n_as_an_id_only_deleted_event(item, create_user, workspace):
    """The whole chain with the REAL callees: issue_activity -> webhook_activity -> webhook_send_task.

    Each hop is called with the kwargs the previous one queued, so a kwarg renamed on either side
    raises TypeError here instead of in the worker. Only the network (pinned_fetch) and the log row
    are stubbed; the payload asserted is the one HMAC-signed and POSTed.
    """
    n8n = Webhook.objects.create(workspace=workspace, url="https://n8n.example.com/webhook/plane", issue=True)
    Webhook.objects.create(workspace=workspace, url="https://other.example.com/hook", issue=False, project=True)
    Webhook.objects.create(workspace=workspace, url="https://off.example.com/hook", issue=True, is_active=False)
    item.delete()

    with mock.patch(f"{TASK}.webhook_activity") as hook, mock.patch(f"{TASK}.redis_instance"):
        _activity(item, create_user, "issue.activity.deleted", {"issue_id": str(item.id)})
    with mock.patch("plane.bgtasks.webhook_task.webhook_send_task") as send:
        webhook_activity(**hook.delay.call_args.kwargs)
    send.delay.assert_called_once()  # the inactive and the non-issue webhooks get nothing
    assert send.delay.call_args.kwargs["webhook_id"] == n8n.id

    response = mock.Mock(status_code=200, headers={}, text="ok")
    with (
        mock.patch("plane.bgtasks.webhook_task.pinned_fetch", return_value=response) as fetch,
        mock.patch("plane.bgtasks.webhook_task.save_webhook_log") as log,
    ):
        webhook_send_task(**send.delay.call_args.kwargs)
    fetch.assert_called_once()
    assert fetch.call_args.args[1] == n8n.url
    payload = fetch.call_args.kwargs["json"]
    assert payload["event"] == "issue"
    assert payload["action"] == "deleted"  # plane-bot accepts "delete" and "deleted"
    # no target_date in the data: that is what sends n8n's If down its DELETE branch
    assert payload["data"] == {"id": str(item.id)}
    assert payload["workspace_slug"] == workspace.slug
    assert str(payload["activity"]["actor"]["id"]) == str(create_user.id)
    assert fetch.call_args.kwargs["headers"]["X-Plane-Event"] == "issue"
    assert log.call_args.kwargs["response_status"] == 200


# --- the soft-delete cascade: sub-items and a deleted project's items (APLANE-56) --------------

HOOK = "plane.bgtasks.webhook_task.webhook_activity"  # imported inside deletion_task at call time


def _soft_delete_as(obj, user):
    """What SoftDeleteModel.delete() does inside a request: deleted_at + updated_by = the deleter.
    Written with update() so no current-user machinery is needed; the cascade is then run inline."""
    type(obj).all_objects.filter(pk=obj.pk).update(deleted_at=timezone.now(), updated_by=user)
    soft_delete_related_objects(obj._meta.app_label, obj._meta.model_name, obj.pk)


def _announced(hook):
    return {c.kwargs["event_id"]: c.kwargs for c in hook.delay.call_args_list}


def test_sub_items_of_a_deleted_item_are_announced_with_the_deleter(item, create_user, workspace):
    child = Issue.objects.create(name="child", project=item.project, workspace=workspace, parent=item)
    grandchild = Issue.objects.create(name="grandchild", project=item.project, workspace=workspace, parent=child)
    gone = Issue.objects.create(name="already deleted", project=item.project, workspace=workspace, parent=item)
    Issue.all_objects.filter(pk=gone.pk).update(deleted_at=timezone.now())

    with mock.patch(HOOK) as hook:
        _soft_delete_as(item, create_user)

    sent = _announced(hook)
    # the root's own webhook comes from issue_activity on the direct path, never twice
    assert set(sent) == {str(child.id), str(grandchild.id)}
    for kw in sent.values():
        assert kw["event"] == "issue" and kw["verb"] == "deleted"
        assert kw["slug"] == workspace.slug
        # the grandchild is reached from the child, whose save() inside the task nulled updated_by:
        # the actor has to be carried down from the root, not re-read
        assert kw["actor_id"] == str(create_user.id)
    assert Issue.objects.filter(pk__in=[child.id, grandchild.id]).count() == 0


def test_every_item_of_a_deleted_project_is_announced(item, create_user, workspace):
    other = Issue.objects.create(name="other", project=item.project, workspace=workspace)
    sub = Issue.objects.create(name="sub", project=item.project, workspace=workspace, parent=other)
    with mock.patch(HOOK) as hook:
        _soft_delete_as(item.project, create_user)
    assert set(_announced(hook)) == {str(item.id), str(other.id), str(sub.id)}


def test_a_cascade_with_no_known_deleter_still_reaches_n8n(item, create_user, workspace):
    """Root saved outside a request (updated_by None): the webhook goes out with actor None
    instead of being dropped by get_model_data's DoesNotExist."""
    n8n = Webhook.objects.create(workspace=workspace, url="https://n8n.example.com/webhook/plane", issue=True)
    child = Issue.objects.create(name="child", project=item.project, workspace=workspace, parent=item)
    with mock.patch(HOOK) as hook:
        _soft_delete_as(item, None)
    (kw,) = hook.delay.call_args_list
    assert kw.kwargs["actor_id"] is None
    with mock.patch("plane.bgtasks.webhook_task.webhook_send_task") as send:
        webhook_activity(**kw.kwargs)
    send.delay.assert_called_once()
    sent = send.delay.call_args.kwargs
    assert sent["webhook_id"] == n8n.id
    assert sent["event_data"] == {"id": str(child.id)}
    assert sent["activity"]["actor"] is None


def test_project_delete_announces_each_item_once_even_when_reached_twice(item, create_user, workspace):
    """A parent NEWER than its sub-item is walked first (Issue ordering is -created_at): its
    recursion deletes the sub-item, and then the project's already-materialised list reaches the
    same sub-item again through a stale copy. Counted as a list, not a set, on purpose. A State
    adds the third path (Issue.state is CASCADE)."""
    state = State.objects.create(name="Todo", project=item.project, workspace=workspace, group="unstarted")
    old_child = Issue.objects.create(name="old child", project=item.project, workspace=workspace, state=state)
    new_parent = Issue.objects.create(name="new parent", project=item.project, workspace=workspace, state=state)
    Issue.objects.filter(pk=old_child.pk).update(parent=new_parent)
    with mock.patch(HOOK) as hook:
        _soft_delete_as(item.project, create_user)
    ids = sorted(c.kwargs["event_id"] for c in hook.delay.call_args_list)
    assert ids == sorted([str(item.id), str(old_child.id), str(new_parent.id)])


def test_a_failed_announce_does_not_stop_the_cascade(item, create_user, workspace):
    """Publishing to the broker can raise; before the webhook existed the cascade only saved and
    recursed, so a broker hiccup must not leave sub-items alive now."""
    child = Issue.objects.create(name="child", project=item.project, workspace=workspace, parent=item)
    grandchild = Issue.objects.create(name="grandchild", project=item.project, workspace=workspace, parent=child)
    with mock.patch(HOOK) as hook:
        hook.delay.side_effect = RuntimeError("broker down")
        _soft_delete_as(item, create_user)
    assert Issue.objects.filter(pk__in=[child.id, grandchild.id]).count() == 0
