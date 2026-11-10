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
from unittest.mock import patch

import pytest

from django.db import IntegrityError
from django.utils import timezone

from plane.bgtasks.deletion_task import hard_delete
from plane.db.models import (
    Description,
    DescriptionVersion,
    FileAsset,
    Issue,
    IssueActivity,
    IssueComment,
    Project,
    State,
)

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


@pytest.fixture(autouse=True)
def storage():
    """No test in this module may reach the bucket.

    Patched at `plane.settings.storage`, not at the task module, because `_purge_blobs` imports
    `S3Storage` lazily: `plane.db.mixins` imports the task module, so a top-level import there
    would pull boto3 and django-storages into the import chain of every model.
    """
    with patch("plane.settings.storage.S3Storage") as mocked:
        mocked.return_value.delete_files.return_value = True
        yield mocked.return_value


@pytest.fixture
def purge(django_capture_on_commit_callbacks):
    """Run the task and then its `on_commit` callbacks — the storage sweep is one of them.

    Every test here but two runs inside pytest-django's outer atomic block, so the task's own
    `transaction.atomic()` is a savepoint that never COMMITs and a real `on_commit` would never
    fire. Note the order differs from production: this executes the callbacks when the `with` block
    exits, i.e. AFTER `hard_delete` has returned and written its summary, while in production they
    run inside the COMMIT, just before it. That is why `_purge_blobs` must never raise, and why
    `test_the_storage_sweep_runs_only_on_commit` tests the ordering instead of this fixture.
    """

    def _run():
        with django_capture_on_commit_callbacks(execute=True):
            hard_delete()

    return _run


def _comment(issue, project, user, html="<p>x</p>"):
    """`IssueComment.save` creates the `Description` row these tests are about."""
    return IssueComment.objects.create(
        issue=issue, project=project, workspace=project.workspace, actor=user, comment_html=html
    )


def _asset(project, issue=None, comment=None, key="ws/default-file.png", size=1234):
    return FileAsset.objects.create(
        workspace=project.workspace,
        project=project,
        issue=issue,
        comment=comment,
        asset=key,
        size=size,
        entity_type="ISSUE_ATTACHMENT",
        attributes={"name": "file.png", "type": "image/png", "size": size},
    )


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


def test_the_summary_counts_per_label_and_not_the_whole_cascade(armed, project, create_user, caplog):
    """The armed summary is the evidence an operator uses to decide whether arming this on prod was
    safe, so its numbers have to mean what their labels say.

    `QuerySet.delete()` returns `(rows_deleted_across_every_model, {label: n})`. The purge loop used
    to take that grand TOTAL and file it under the root model's label, discarding the breakdown — so
    one doomed work item with one activity row reported `db.Issue: 2`, and on dev six doomed projects
    reported `db.Project: 309` while exactly 6 project rows existed to delete. The disarmed report
    above it counts per label, from the collector, so the two halves of the same task disagreed by a
    factor nobody could reconstruct.

    Asserted on the log line rather than a return value because the log line IS the output.
    """
    issue = _issue(project)
    _activity(issue, project)
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        hard_delete()

    assert "hard_delete purged" in caplog.text
    # One issue, and its activity row under its OWN label. The pre-fix code said `db.Issue: 2`.
    assert "'db.Issue': 1" in caplog.text, f"db.Issue must count issues, not the cascade: {caplog.text}"
    assert "db.IssueActivity" in caplog.text, "the activity row still has to be reported, as itself"


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


# --- APLANE-41: what a purge used to leave behind for ever --------------------


def test_a_purged_comment_no_longer_leaves_its_description_behind(armed, project, create_user):
    """`IssueComment.description` is a one-to-one ON THE COMMENT, so the CASCADE ran the other way
    and the `Description` survived its comment. Nothing ever set `Description.deleted_at` either,
    so the catch-all sweep could not reach it: `descriptions` grew for ever."""
    issue = _issue(project)
    comment = _comment(issue, project, create_user)
    description_id = comment.description_id
    assert description_id, "the comment's save must have created a Description, or this proves nothing"
    version = DescriptionVersion.objects.create(
        description_id=description_id, project=project, workspace=project.workspace, description_html="<p>x</p>"
    )
    _activity(issue, project, field="comment", issue_comment=comment)
    _age(IssueComment, comment.pk, OLD)

    hard_delete()

    assert not IssueComment.all_objects.filter(pk=comment.pk).exists(), "the comment must physically go"
    assert not Description.all_objects.filter(pk=description_id).exists(), "and its Description with it"
    assert not DescriptionVersion.all_objects.filter(pk=version.pk).exists(), "versions cascade off the Description"


def test_a_live_comments_description_is_never_touched(armed, project, create_user):
    issue = _issue(project)
    doomed = _comment(issue, project, create_user, "<p>doomed</p>")
    live = _comment(issue, project, create_user, "<p>live</p>")
    _activity(issue, project, field="comment", issue_comment=doomed)
    _age(IssueComment, doomed.pk, OLD)

    hard_delete()

    assert not Description.all_objects.filter(pk=doomed.description_id).exists()
    assert IssueComment.all_objects.filter(pk=live.pk).exists()
    assert Description.all_objects.filter(pk=live.description_id).exists(), (
        "the sweep is filtered on `nothing points at me any more`, so a live comment keeps its row"
    )


def test_the_orphan_sweep_cannot_delete_a_description_whose_comment_still_exists(armed, project, create_user):
    """The guard, tested directly, because it is the load-bearing one.

    The ids are collected before the transaction opens, and the one-to-one is on the comment, so a
    `Description` delete CASCADES INTO its comment. Without `issue_comment_description__isnull=True`
    this step could destroy a live comment — which is a worse bug than the leak it fixes.
    """
    from plane.bgtasks.deletion_task import _purge_orphaned_descriptions

    issue = _issue(project)
    comment = _comment(issue, project, create_user)

    removed = _purge_orphaned_descriptions({comment.description_id})

    assert removed == {}, "nothing is orphaned, so nothing may be removed"
    assert IssueComment.all_objects.filter(pk=comment.pk).exists(), "deleting the Description would have taken it"
    assert Description.all_objects.filter(pk=comment.description_id).exists()


def test_the_orphan_sweep_keeps_the_description_of_a_merely_SOFT_deleted_comment(armed, project, create_user):
    """The claim the guard rests on: soft delete here is a column, not row visibility, so the join
    still sees a soft-deleted comment pointing at its `Description`. If it did not, a comment inside
    the retention window would lose its body while the comment itself is still restorable."""
    from plane.bgtasks.deletion_task import _purge_orphaned_descriptions

    issue = _issue(project)
    comment = _comment(issue, project, create_user)
    _age(IssueComment, comment.pk, RECENT)

    removed = _purge_orphaned_descriptions({comment.description_id})

    assert removed == {}
    assert Description.all_objects.filter(pk=comment.description_id).exists()


def test_the_storage_object_of_a_purged_attachment_is_deleted(storage, purge, armed, project, caplog):
    """The key lives only in the row: `FileAsset.issue` is CASCADE, so the purge removed the row and
    left an object nothing could name again short of listing the whole bucket."""
    issue = _issue(project)
    _activity(issue, project)
    asset = _asset(project, issue=issue, key="ws/one-file.png")
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        purge()

    assert not FileAsset.all_objects.filter(pk=asset.pk).exists(), "the row cascades off the work item"
    storage.delete_files.assert_called_once_with(object_names=["ws/one-file.png"])
    assert "ws/one-file.png" in caplog.text, (
        "the key has to be logged: the row is gone, so that line is the only way back to the object"
    )


def test_the_storage_sweep_runs_only_on_commit(storage, armed, project):
    """The ordering, which is the whole safety property, pinned.

    No `purge` fixture here on purpose: inside pytest-django's atomic block the task's transaction
    never COMMITs, so a correct implementation touches nothing. If `_purge_blobs` is ever called
    directly instead of through `transaction.on_commit` — moving it inside the `with` block leaves
    every other test green — this fails. In production that version empties part of the bucket and
    then rolls the rows back on a COMMIT-time `IntegrityError`, which is how APLANE-40 failed.
    """
    issue = _issue(project)
    _activity(issue, project)
    _asset(project, issue=issue, key="ws/on-commit.png")
    _age(Issue, issue.pk, OLD)

    hard_delete()

    storage.delete_files.assert_not_called()


def test_the_storage_object_of_a_legacy_attachment_row_is_deleted_too(storage, purge, armed, project):
    """`issue_attachments` is empty on our instance (measured 2026-11-09) and nothing writes to the
    model any more, but the table and its CASCADE are still there and it has NO `size` column — the
    branch no `FileAsset` test can reach. "Simplifying" `_doomed_blobs` to always read `size` would
    raise `FieldError` every night on an instance that still has these rows, with the suite green.
    """
    # Imported from the module, not the package: `IssueAttachment` is not in
    # `plane/db/models/__init__.py` at all, which is its own evidence that the model is dead.
    from plane.db.models.issue import IssueAttachment

    issue = _issue(project)
    _activity(issue, project)
    IssueAttachment.objects.create(
        issue=issue, project=project, workspace=project.workspace, asset="ws/legacy.png", attributes={}
    )
    _age(Issue, issue.pk, OLD)

    purge()

    storage.delete_files.assert_called_once_with(object_names=["ws/legacy.png"])


def test_the_storage_sweep_batches_at_the_s3_limit(storage, purge, armed, project, monkeypatch):
    """`DeleteObjects` rejects more than 1000 keys with `MalformedXML`, which `delete_files` turns
    into a False return — the whole sweep would be reported as failed and every object would leak.
    `_KEY_CHUNK` is patched down rather than creating 1001 rows."""
    import plane.bgtasks.deletion_task as task

    monkeypatch.setattr(task, "_KEY_CHUNK", 2)
    issue = _issue(project)
    _activity(issue, project)
    for n in range(3):
        _asset(project, issue=issue, key=f"ws/batch-{n}.png")
    _age(Issue, issue.pk, OLD)

    purge()

    assert storage.delete_files.call_count == 2, "3 keys at 2 per request is two batches"
    assert sorted(key for call in storage.delete_files.call_args_list for key in call.kwargs["object_names"]) == [
        "ws/batch-0.png",
        "ws/batch-1.png",
        "ws/batch-2.png",
    ], "and every key is in exactly one of them"


def test_a_purge_that_rolls_back_deletes_nothing_from_storage(storage, purge, armed, project, monkeypatch):
    """Storage runs after the COMMIT and never inside it. A rollback that had already emptied part
    of the bucket would keep every row and lose the objects they point at — worse than the leak."""
    import plane.bgtasks.deletion_task as task

    issue = _issue(project)
    _activity(issue, project)
    _asset(project, issue=issue)
    _age(Issue, issue.pk, OLD)

    def _boom(_ids):
        raise RuntimeError("boom, inside the purge transaction")

    monkeypatch.setattr(task, "_purge_orphaned_descriptions", _boom)

    with pytest.raises(RuntimeError):
        purge()

    storage.delete_files.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_a_purge_that_fails_at_COMMIT_leaves_the_bucket_untouched(storage, settings, workspace, create_user):
    """The production failure the `on_commit` registration exists for, with a REAL commit.

    `_clear_blocking_activity_links` is stubbed out, which is exactly the APLANE-40 state: the
    `DELETE FROM issues` succeeds because `IssueActivity.issue` is DO_NOTHING, and the deferred
    foreign key is rejected at COMMIT. A storage sweep placed after the `with` block would never
    run here either — but one placed INSIDE it would already have emptied the bucket by then, and
    every row survives the rollback with `restore_related_objects` a stub.
    """
    import plane.bgtasks.deletion_task as task

    settings.HARD_DELETE_ENABLED = True
    settings.HARD_DELETE_AFTER_DAYS = 60

    created = Project.objects.create(name="Commit", identifier="CMT", workspace=workspace)
    State.objects.create(
        name="Done", group="completed", color="#60646C", default=True, project=created, workspace=workspace
    )
    issue = _issue(created)
    _activity(issue, created)
    _asset(created, issue=issue, key="ws/commit-fails.png")
    _age(Issue, issue.pk, OLD)

    original = task._clear_blocking_activity_links
    task._clear_blocking_activity_links = lambda *_args: (0, 0)
    try:
        with pytest.raises(IntegrityError):
            hard_delete()
    finally:
        task._clear_blocking_activity_links = original

    # The COMMIT failed, so the bucket must be untouched.
    storage.delete_files.assert_not_called()
    assert Issue.all_objects.filter(pk=issue.pk).exists(), "and every row rolled back"


def test_a_storage_error_that_delete_files_does_not_catch_is_counted_not_raised(storage, purge, armed, project, caplog):
    """`S3Storage.delete_files` only catches `ClientError`, so `EndpointConnectionError` and the
    rest of `BotoCoreError` reach this task. The sweep runs inside the COMMIT, so letting one
    escape would make `hard_delete` report a committed purge as a total rollback."""
    storage.delete_files.side_effect = RuntimeError("minio unreachable")
    issue = _issue(project)
    _activity(issue, project)
    _asset(project, issue=issue, key="ws/boom.png")
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        purge()

    assert "storage delete FAILED" in caplog.text
    assert "NOTHING was purged" not in caplog.text, "the purge itself committed; only the sweep failed"
    assert not Issue.all_objects.filter(pk=issue.pk).exists()


def test_the_storage_sweep_never_raises_into_the_commit(storage, purge, armed, project, monkeypatch, caplog):
    """The outer guard: anything at all going wrong in the sweep must be logged, not raised."""
    import plane.bgtasks.deletion_task as task

    def _boom(_keys):
        raise RuntimeError("the sweep itself broke")

    monkeypatch.setattr(task, "_keys_still_referenced", _boom)
    issue = _issue(project)
    _activity(issue, project)
    _asset(project, issue=issue)
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("ERROR", logger="plane.worker"):
        purge()

    assert "the storage sweep itself failed" in caplog.text
    assert not Issue.all_objects.filter(pk=issue.pk).exists(), "the purge committed; only the sweep failed"


def test_a_storage_key_a_surviving_row_still_points_at_is_kept(storage, purge, armed, project):
    """Not hypothetical: migration `0079_auto_20241009_0619` copied every `issue_attachments.asset`
    into a new `file_assets` row VERBATIM and left the old rows in place, so on any instance that
    predates October 2024 each legacy attachment has two rows naming one object. Deleting the key
    on behalf of one of them would leave the other row intact and pointing at nothing, with no way
    back. (Our own `issue_attachments` is empty, measured 2026-11-09.)

    The second asset is what makes this a test of the guard rather than of the sweep: without it,
    "drop the referenced key" and "abort the whole sweep" look identical.
    """
    doomed_issue = _issue(project, "doomed")
    live_issue = _issue(project, "live")
    _activity(doomed_issue, project)
    _activity(live_issue, project)
    _asset(project, issue=doomed_issue, key="ws/shared-file.png")
    _asset(project, issue=doomed_issue, key="ws/only-doomed.png")
    survivor = _asset(project, issue=live_issue, key="ws/shared-file.png")
    _age(Issue, doomed_issue.pk, OLD)

    purge()

    assert not Issue.all_objects.filter(pk=doomed_issue.pk).exists()
    assert FileAsset.all_objects.filter(pk=survivor.pk).exists()
    # The shared key is kept and the rest of the batch still goes.
    storage.delete_files.assert_called_once_with(object_names=["ws/only-doomed.png"])


def test_a_failed_storage_delete_is_logged_with_its_keys(storage, purge, armed, project, caplog):
    """`S3Storage.delete_files` swallows `ClientError` and returns False. The rows are already gone
    by then, so the log line is the only thing the objects could still be found by."""
    storage.delete_files.return_value = False
    issue = _issue(project)
    _activity(issue, project)
    _asset(project, issue=issue, key="ws/unreachable.png")
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        purge()

    assert "storage delete FAILED" in caplog.text
    assert "ws/unreachable.png" in caplog.text, "the keys have to be in the log, not only in the broker"


def test_disarmed_it_counts_the_storage_objects_and_descriptions_it_would_leave(
    storage, settings, project, create_user, caplog
):
    """The disarmed report is the only measurement an operator gets before arming, so the two leaks
    this ticket is about have to appear in it."""
    settings.HARD_DELETE_ENABLED = False
    settings.HARD_DELETE_AFTER_DAYS = 60
    issue = _issue(project)
    comment = _comment(issue, project, create_user)
    asset = _asset(project, issue=issue, size=4096)
    _age(Issue, issue.pk, OLD)

    with caplog.at_level("INFO", logger="plane.worker"):
        hard_delete()

    assert "would remove 1 storage object(s) totalling at least 4096 bytes" in caplog.text
    assert "1 Description row(s)" in caplog.text
    storage.delete_files.assert_not_called()
    assert FileAsset.all_objects.filter(pk=asset.pk).exists(), "disarmed, it must not delete anything"
    assert Description.all_objects.filter(pk=comment.description_id).exists()
