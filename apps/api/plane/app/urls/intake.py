# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path


from plane.app.views import (
    IntakeViewSet,
    IntakeIssueViewSet,
    IntakeWorkItemDescriptionVersionEndpoint,
)


urlpatterns = [
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intakes/",
        # POST is deliberately NOT routed (APLANE-38). It answered 500 for every caller, so no
        # working client can exist — and repairing it was measured to be worse than leaving it
        # broken. Three reasons, none of them about ordering:
        #   1. `IntakeSerializer` is `fields = "__all__"` with only project and workspace read-only,
        #      so a member could POST `is_default: true`. Two defaults tie on the ordering's first
        #      key, the name decides, and `destroy` refuses to delete ANY default — unremovable
        #      through the API, since `partial_update` is not implemented either (405).
        #   2. An intake squatting the name `f"{project.name} Intake"` makes enabling intake_view
        #      fail: `ProjectViewSet` commits `intake_view=True` BEFORE creating the default, hits
        #      the (name, project) unique constraint, and leaves the project with intake on and no
        #      default — 400 on every retry, fixable only by deleting the squatter.
        #   3. `destroy` admits MEMBER and refuses only defaults, so with non-default intakes
        #      reachable a member could publish one on a board, let public submissions accumulate,
        #      then delete it and orphan them.
        # Before re-routing this: make destroy ADMIN-only and refuse an intake a live DeployBoard
        # publishes or that holds live IntakeIssue rows; make `is_default` and `deleted_at`
        # read-only; and decide what should happen when a project already has an intake.
        IntakeViewSet.as_view({"get": "list"}),
        name="intake",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intakes/<uuid:pk>/",
        IntakeViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="intake",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intake-issues/",
        IntakeIssueViewSet.as_view({"get": "list", "post": "create"}),
        name="intake-issue",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intake-issues/<uuid:pk>/",
        IntakeIssueViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="intake-issue",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inboxes/",
        # POST is deliberately NOT routed (APLANE-38). It answered 500 for every caller, so no
        # working client can exist — and repairing it was measured to be worse than leaving it
        # broken. Three reasons, none of them about ordering:
        #   1. `IntakeSerializer` is `fields = "__all__"` with only project and workspace read-only,
        #      so a member could POST `is_default: true`. Two defaults tie on the ordering's first
        #      key, the name decides, and `destroy` refuses to delete ANY default — unremovable
        #      through the API, since `partial_update` is not implemented either (405).
        #   2. An intake squatting the name `f"{project.name} Intake"` makes enabling intake_view
        #      fail: `ProjectViewSet` commits `intake_view=True` BEFORE creating the default, hits
        #      the (name, project) unique constraint, and leaves the project with intake on and no
        #      default — 400 on every retry, fixable only by deleting the squatter.
        #   3. `destroy` admits MEMBER and refuses only defaults, so with non-default intakes
        #      reachable a member could publish one on a board, let public submissions accumulate,
        #      then delete it and orphan them.
        # Before re-routing this: make destroy ADMIN-only and refuse an intake a live DeployBoard
        # publishes or that holds live IntakeIssue rows; make `is_default` and `deleted_at`
        # read-only; and decide what should happen when a project already has an intake.
        IntakeViewSet.as_view({"get": "list"}),
        name="inbox",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inboxes/<uuid:pk>/",
        IntakeViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="inbox",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inbox-issues/",
        IntakeIssueViewSet.as_view({"get": "list", "post": "create"}),
        name="inbox-issue",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inbox-issues/<uuid:pk>/",
        IntakeIssueViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="inbox-issue",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intake-work-items/<uuid:work_item_id>/description-versions/",
        IntakeWorkItemDescriptionVersionEndpoint.as_view(),
        name="intake-work-item-versions",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/intake-work-items/<uuid:work_item_id>/description-versions/<uuid:pk>/",
        IntakeWorkItemDescriptionVersionEndpoint.as_view(),
        name="intake-work-item-versions",
    ),
]
