# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The nightly purge actually purges, and only when it is armed (APLANE-40).

Before this, `hard_delete` had never completed once: `IssueActivity.issue` and
`IssueActivity.issue_comment` are `on_delete=DO_NOTHING` yet keep their database constraints, so
Django emitted a bare `DELETE FROM issues`, Postgres refused it, and the task died on the issue
step every night. Every work item carries an `issue.activity.created` row from creation, so the
violation was universal. Measured on prod 2026-11-06: 102 work items soft-deleted more than 60
days earlier were all still present.

Nothing in this suite exercised this task, which is how that survived for the life of the
instance. Note what actually fails without `_clear_blocking_activity_links`: the first test fails
on its own second assertion (the orphan activity row is still there), and the IntegrityError shows
up in Django's teardown constraint check, not in the test body — DO_NOTHING means the DELETE
itself succeeds and merely leaves the orphan behind. `_assert_no_dangling_activity_rows` exists so
that the cascade tests assert it in their own bodies rather than relying on that teardown.

`deleted_at` is always set with `update()` rather than `.delete()` — that is both what a lost
`soft_delete_related_objects` leaves behind and what keeps celery out of these tests.
"""

from pathlib import Path

import pytest

from django.utils import timezone

from plane.bgtasks.deletion_task import hard_delete
from plane.db.models import Issue, IssueActivity, IssueComment, Project, State

pytestmark = pytest.mark.unit

OLD = 61
RECENT = 59


@pytest.fixture
def armed(settings):
    """The task is off by default; these tests are about what it does when it is on."""
    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60
    return settings


@pytest.fixture
def project(db, workspace, create_user):
    created = Project.objects.create(name="Purge", identifier="PRG", workspace=workspace)
    State.objects.create(
        name="Done", group="completed", color="#60646C", default=True, project=created, workspace=workspace
    )
    return created


def _issue(project, name="work item", **kwargs):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, **kwargs)


def _activity(issue, project, **kwargs):
    """The row every work item gets at creation, and the one that blocked every purge."""
    kwargs.setdefault("verb", "created")
    kwargs.setdefault("field", "issue")
    return IssueActivity.objects.create(issue=issue, project=project, workspace=project.workspace, **kwargs)


def _age(model, pk, days):
    model.all_objects.filter(pk=pk).update(deleted_at=timezone.now() - timezone.timedelta(days=days))


def _assert_no_dangling_activity_rows():
    """No `issue_activities` row may point at a work item or comment that no longer exists.

    Django creates its foreign keys DEFERRABLE INITIALLY DEFERRED, so a dangling row is rejected
    at COMMIT rather than at the DELETE. In a test that surfaces only in
    `TestCase._fixture_teardown`'s constraint check — after the assertions, invisibly, and one
    `transaction=True` away from being lost. So the cascade tests assert it themselves.
    """
    issue_ids = set(Issue.all_objects.values_list("id", flat=True))
    comment_ids = set(IssueComment.all_objects.values_list("id", flat=True))
    dangling = [
        (row.pk, row.issue_id, row.issue_comment_id)
        for row in IssueActivity.all_objects.all()
        if (row.issue_id and row.issue_id not in issue_ids)
        or (row.issue_comment_id and row.issue_comment_id not in comment_ids)
    ]
    assert dangling == [], f"activity rows left pointing at rows that no longer exist: {dangling}"


def test_a_soft_deleted_work_item_is_finally_purged(armed, project, create_user):
    issue = _issue(project)
    activity = _activity(issue, project)
    _age(Issue, issue.pk, OLD)

    hard_delete()

    assert not Issue.all_objects.filter(pk=issue.pk).exists(), "the work item must physically go"
    assert not IssueActivity.all_objects.filter(pk=activity.pk).exists(), "its activity row goes with it"


def test_a_purged_comment_keeps_its_activity_row_when_the_work_item_is_alive(armed, project, create_user):
    """The second wall, and why the two foreign keys are treated differently.

    A comment can be deleted on a work item nobody deleted. Dropping that comment's activity rows
    would erase part of a LIVE item's history, so they are detached instead — which is also what
    lets the comment row itself go.
    """
    issue = _issue(project)
    comment = IssueComment.objects.create(
        issue=issue, project=project, workspace=project.workspace, actor=create_user, comment_html="<p>x</p>"
    )
    activity = _activity(issue, project, field="comment", issue_comment=comment)
    _age(IssueComment, comment.pk, OLD)

    hard_delete()

    assert not IssueComment.all_objects.filter(pk=comment.pk).exists(), "the comment must physically go"
    assert Issue.all_objects.filter(pk=issue.pk).exists(), "its work item is alive and must stay"
    row = IssueActivity.all_objects.filter(pk=activity.pk).first()
    assert row is not None, "the activity row must survive — it is a live item's history"
    assert row.issue_comment_id is None, "and be detached from the comment that no longer exists"


def test_a_purged_project_takes_issues_whose_own_cascade_never_ran(armed, project):
    """The soft cascade has no retry and swallows per-relation failures, so a soft-deleted project
    can still own issues with `deleted_at` NULL, and the purge has to cope with that.

    This test does NOT exercise the activity link clearing: `IssueActivity` extends
    `ProjectBaseModel`, whose `project` FK is CASCADE, so the project's own cascade removes those
    rows and the test passes with the clearing stubbed out. It covers the lost-cascade shape, and
    the dangling assertion below is the part that would catch a regression elsewhere."""
    issue = _issue(project, "issue of a deleted project")
    _activity(issue, project)
    _age(Project, project.pk, OLD)

    hard_delete()

    assert not Project.all_objects.filter(pk=project.pk).exists()
    assert not Issue.all_objects.filter(pk=issue.pk).exists()
    _assert_no_dangling_activity_rows()


def test_rows_inside_the_window_are_untouched(armed, project):
    issue = _issue(project)
    _activity(issue, project)
    _age(Issue, issue.pk, RECENT)

    hard_delete()

    assert Issue.all_objects.filter(pk=issue.pk).exists(), "59 days is inside the 60-day window"


def test_a_LIVE_sub_item_of_a_purged_parent_is_deleted_too(armed, project):
    """Documented, not desired: the collector walks `_base_manager` and `Issue.parent` is CASCADE,
    so a sub-item that is still alive — because its parent's soft cascade was lost — is physically
    deleted along with the parent. Named here so that the behaviour is a decision rather than a
    surprise; it is the reason the task ships disarmed and reports first."""
    parent = _issue(project, "parent")
    child = _issue(project, "live child", parent=parent)
    _activity(parent, project)
    _activity(child, project)
    _age(Issue, parent.pk, OLD)

    hard_delete()

    assert not Issue.all_objects.filter(pk=parent.pk).exists()
    assert not Issue.all_objects.filter(pk=child.pk).exists(), (
        "a live sub-item goes with its purged parent — the disarmed report counts these as LIVE, "
        "which is the number to read before arming"
    )
    _assert_no_dangling_activity_rows()


def test_disarmed_it_deletes_nothing_and_says_what_it_would(settings, project, caplog):
    settings.HARD_DELETE_ENABLED = False
    settings.HARD_DELETE_AFTER_DAYS = 60
    issue = _issue(project)
    _activity(issue, project)
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        hard_delete()

    assert Issue.all_objects.filter(pk=issue.pk).exists(), "disarmed, it must not delete anything"
    assert "hard_delete is OFF" in caplog.text
    assert "db.Issue" in caplog.text, "and the report must name what it would have removed"
    assert "STILL LIVE" in caplog.text, (
        "the live breakdown is the number that decides whether arming is safe; a report without "
        "it cannot answer the question it exists for"
    )


def test_an_issue_in_a_purged_state_goes_with_it(armed, project):
    """`Issue.state` is CASCADE, so purging a soft-deleted state deletes the work items still in
    it — including live ones. This is the second cascade path a reap keyed on `issue__deleted_at`
    would have missed, and the reason the link clearing asks Django's collector instead."""
    state = State.objects.create(name="Gone", group="backlog", project=project, workspace=project.workspace)
    issue = _issue(project, "issue in a doomed state", state=state)
    _activity(issue, project)
    _age(State, state.pk, OLD)

    hard_delete()

    assert not State.all_objects.filter(pk=state.pk).exists()
    assert not Issue.all_objects.filter(pk=issue.pk).exists(), "it cascades off the state"
    _assert_no_dangling_activity_rows()


def test_nothing_doomed_means_nothing_is_touched(armed, project, create_user):
    """The over-reach control: the link clearing must not detach or delete anything when no row is
    old enough to purge."""
    issue = _issue(project)
    comment = IssueComment.objects.create(
        issue=issue, project=project, workspace=project.workspace, actor=create_user, comment_html="<p>x</p>"
    )
    activity = _activity(issue, project, field="comment", issue_comment=comment)

    hard_delete()

    assert Issue.all_objects.filter(pk=issue.pk).exists()
    assert IssueComment.all_objects.filter(pk=comment.pk).exists()
    assert IssueActivity.all_objects.get(pk=activity.pk).issue_comment_id == comment.pk, (
        "nothing was doomed, so nothing may be detached"
    )


def test_the_shipped_default_is_disarmed(settings):
    """The kill switch has to be off in the SOURCE, not only in this environment.

    Without this assertion, flipping the default to "1" leaves the whole suite green — which is
    the green-gate failure this fork has already paid for once.
    """
    import plane.settings.common as common_settings
    import plane.settings.production as production_settings

    source = Path(common_settings.__file__).read_text()

    assert 'HARD_DELETE_ENABLED = os.environ.get("HARD_DELETE_ENABLED", "0") == "1"' in source
    # production.py is the module prod actually loads and it does `from .common import *`, so a
    # line there would override the default while a grep of common.py alone stayed green.
    assert "HARD_DELETE_ENABLED" not in Path(production_settings.__file__).read_text(), (
        "production.py must not override the kill switch"
    )
    assert settings.HARD_DELETE_ENABLED is False, "and it must be off in this environment too"


def test_the_retention_window_cannot_select_everything(settings):
    """`HARD_DELETE_AFTER_DAYS=0` or a negative value would put the cutoff at or after `now` and
    purge the entire recycle bin, live cascades included, on the first run. The helper that guards
    the other retention settings allows 0, so this one is floored on top of it."""
    import plane.settings.common as common_settings

    source = Path(common_settings.__file__).read_text()

    assert 'HARD_DELETE_AFTER_DAYS = max(1, _retention_days("HARD_DELETE_AFTER_DAYS", 60))' in source
    assert settings.HARD_DELETE_AFTER_DAYS >= 1


@pytest.mark.parametrize("raw", ["0", "-1", "-999"])
def test_the_clamp_turns_a_window_that_would_purge_everything_into_one_day(monkeypatch, raw):
    """The assertion above only proves the source line exists and that the default of 60 is >= 1.

    This one exercises the clamp: 0 puts the cutoff at `now` and a negative value puts it in the
    future, either of which selects the entire recycle bin — live cascades included — on the first
    run. `_retention_days` already rejects negatives but accepts 0, which is why the floor is on
    top of it.
    """
    import importlib

    import plane.settings.common as common_settings

    monkeypatch.setenv("HARD_DELETE_AFTER_DAYS", raw)
    reloaded = importlib.reload(common_settings)
    try:
        assert reloaded.HARD_DELETE_AFTER_DAYS >= 1, f"{raw} must not produce a cutoff at or after now()"
    finally:
        monkeypatch.undo()
        importlib.reload(common_settings)


def test_the_report_counts_a_live_row_as_live(settings, project, caplog):
    """The live breakdown has to carry a real count, not just the words.

    `assert "STILL LIVE" in caplog.text` passes on an empty breakdown, because the phrase is part
    of the format string. This asserts the number for the case the whole report exists for: a live
    sub-item that a purge would destroy.
    """
    settings.HARD_DELETE_ENABLED = False
    settings.HARD_DELETE_AFTER_DAYS = 60
    parent = _issue(project, "parent")
    _issue(project, "live child", parent=parent)
    _age(Issue, parent.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        hard_delete()

    assert "'db.Issue': 2" in caplog.text, "both work items would be deleted"
    assert "STILL LIVE" in caplog.text
    assert "'db.Issue': 1" in caplog.text, "and exactly one of them is alive — that is the gate number"


@pytest.mark.django_db(transaction=True)
def test_a_failure_in_the_purge_rolls_back_the_activity_clearing(settings, workspace, create_user):
    """The property the previous audit blocked on, and the only test that can cover it.

    Every other test here uses the `db` fixture, which wraps the test in an outer atomic block: the
    task's own `transaction.atomic()` then degrades to a nested block that never COMMITs, so moving
    the clearing back out into its own transaction would leave all of them green. With
    `transaction=True` there are real commits, so this fails if the clearing is ever committed
    separately — which would leave LIVE work items with their history erased and no way back.
    """
    import plane.bgtasks.deletion_task as task

    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60

    created = Project.objects.create(name="Rollback", identifier="RBK", workspace=workspace)
    State.objects.create(
        name="Done", group="completed", color="#60646C", default=True, project=created, workspace=workspace
    )
    parent = _issue(created, "parent")
    child = _issue(created, "live child", parent=parent)
    child_activity = _activity(child, created)
    _age(Issue, parent.pk, OLD)

    class _ExplodesOnPurge:
        """Returns nothing to the collection phase, then raises inside the purge loop."""

        calls = 0

        class _meta:
            label = "tests.ExplodesOnPurge"

        class all_objects:
            @staticmethod
            def filter(**_kwargs):
                _ExplodesOnPurge.calls += 1
                if _ExplodesOnPurge.calls == 1:
                    return []
                raise RuntimeError("boom, inside the purge transaction")

    from plane.db.models import Issue as IssueModel

    monkeypatched = (IssueModel, _ExplodesOnPurge)
    original = task._models_this_task_deletes
    task._models_this_task_deletes = lambda: monkeypatched
    try:
        with pytest.raises(RuntimeError):
            hard_delete()
    finally:
        task._models_this_task_deletes = original
        # No manual cleanup: `transaction=True` flushes the tables afterwards, and deleting the
        # issues here would hit the very foreign key whose survival this test asserts.

    assert IssueActivity.all_objects.filter(pk=child_activity.pk).exists(), (
        "the activity clearing must roll back with the purge — committing it separately is how a "
        "LIVE work item ends up with no history and no restore path"
    )
    assert Issue.all_objects.filter(pk=child.pk).exists(), "and the live sub-item must still be there"
