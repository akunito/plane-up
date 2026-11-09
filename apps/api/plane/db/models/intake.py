# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
import pytz

# Django imports
from django.db import models

# Module imports
from plane.db.mixins import ChangeTrackerMixin
from plane.db.models.project import Project, ProjectBaseModel


class Intake(ProjectBaseModel):
    name = models.CharField(max_length=255)
    description = models.TextField(verbose_name="Intake Description", blank=True)
    is_default = models.BooleanField(default=False)
    view_props = models.JSONField(default=dict)
    logo_props = models.JSONField(default=dict)

    def __str__(self):
        """Return name of the intake"""
        return f"{self.name} <{self.project.name}>"

    class Meta:
        unique_together = ["name", "project", "deleted_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["name", "project"],
                condition=models.Q(deleted_at__isnull=True),
                name="intake_unique_name_project_when_deleted_at_null",
            )
        ]
        verbose_name = "Intake"
        verbose_name_plural = "Intakes"
        db_table = "intakes"
        # The DEFAULT first, then by name (APLANE-38). Upstream ordered by name alone, and the only
        # uniqueness here is (name, project) — nothing enforces one intake per project. Every
        # project-scoped lookup in both API layers is a bare
        # `Intake.objects.filter(workspace__slug=…, project_id=…).first()` — TEN of them, five in
        # `app/views/intake/base.py` and five in `api/views/intake.py` — so a second intake sorting
        # earlier by name would silently become "the" intake for all of them: submissions would land
        # in the shadow and items in the real default would 404 on update and destroy.
        #
        # Fixed here rather than at the nine call sites, which is what the ticket proposed, because
        # one line covers every bare `.first()` including any added later — the failure mode is
        # silent, so the invariant belongs where it cannot be forgotten. The cost is that an upstream
        # merge reverting this line reintroduces the bug quietly, which is what
        # `test_a_second_intake_never_shadows_the_default` and its Meta assertion are for.
        #
        # It does NOT cover `IntakeViewSet.get_queryset`, and measuring that is how a worse bug
        # turned up: that queryset annotates a `Count`, Django drops the default ordering once an
        # aggregate adds a GROUP BY, and the SQL comes out with **no ORDER BY at all** — so `list`
        # was not picking the alphabetically-first intake, it was picking whatever the database
        # returned. That path needs its own explicit `order_by`, and has one. (`list` only:
        # `IntakeViewSet` implements no `retrieve`, so that route is a 405 and never gets here.)
        #
        # The same mechanism is why this line is not a complete defence: any `.annotate()` added to
        # one of those ten lookups would drop the ordering again, just as silently.
        ordering = ("-is_default", "name")


class SourceType(models.TextChoices):
    IN_APP = "IN_APP"


class IntakeIssueStatus(models.IntegerChoices):
    PENDING = -2
    REJECTED = -1
    SNOOZED = 0
    ACCEPTED = 1
    DUPLICATE = 2


class IntakeIssue(ChangeTrackerMixin, ProjectBaseModel):
    TRACKED_FIELDS = ["snoozed_till"]

    intake = models.ForeignKey("db.Intake", related_name="issue_intake", on_delete=models.CASCADE)
    issue = models.ForeignKey("db.Issue", related_name="issue_intake", on_delete=models.CASCADE)
    status = models.IntegerField(
        choices=(
            (-2, "Pending"),
            (-1, "Rejected"),
            (0, "Snoozed"),
            (1, "Accepted"),
            (2, "Duplicate"),
        ),
        default=-2,
    )
    snoozed_till = models.DateTimeField(null=True)
    duplicate_to = models.ForeignKey(
        "db.Issue",
        related_name="intake_duplicate",
        on_delete=models.SET_NULL,
        null=True,
    )
    source = models.CharField(max_length=255, default="IN_APP", null=True, blank=True)
    source_email = models.TextField(blank=True, null=True)
    external_source = models.CharField(max_length=255, null=True, blank=True)
    external_id = models.CharField(max_length=255, blank=True, null=True)
    extra = models.JSONField(default=dict)

    class Meta:
        verbose_name = "IntakeIssue"
        verbose_name_plural = "IntakeIssues"
        db_table = "intake_issues"
        ordering = ("-created_at",)
        indexes = [
            # Small partial index for the unsnooze beat task, which scans for lapsed snoozes every few minutes.
            models.Index(
                fields=["snoozed_till"],
                condition=models.Q(status=IntakeIssueStatus.SNOOZED),
                name="intake_issue_snoozed_till_idx",
            ),
        ]

    def __str__(self):
        """Return name of the Issue"""
        return f"{self.issue.name} <{self.intake.name}>"

    def save(self, *args, **kwargs):
        # A snooze is day-granular whatever time the caller sent: wake at 00:00 of
        # that day in the project's timezone. Project.save() re-times it if the
        # project timezone later changes.
        if self.snoozed_till and (self._state.adding or self.has_changed("snoozed_till")):
            # Inline import: timezone_converter imports plane.db.models.
            from plane.utils.timezone_converter import project_day_start

            project_tz = pytz.timezone(Project.objects.values_list("timezone", flat=True).get(id=self.project_id))
            self.snoozed_till = project_day_start(self.snoozed_till.astimezone(project_tz).date(), project_tz)
        super().save(*args, **kwargs)
