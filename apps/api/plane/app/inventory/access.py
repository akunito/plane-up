# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# The one visibility rule for inventory (brief: "The derived list: what the query must filter on").
# The to-buy list, the counter, suggestions, the project endpoints and every operation use it.
#
# - Membership and is_active in the SAME filter() (WorkspaceModulesEndpoint pattern): split across two
#   filters, a join would match a stale inactive row and an active one separately.
# - The soft-delete manager does not apply across joins and the soft-delete cascade is asynchronous, so
#   project, list and item deletion are each filtered explicitly.
# - Guests get nothing, and a workspace admin gets nothing extra: unlike allow_permission, a workspace
#   admin whose project role is guest is not let in.

from django.db.models import Exists, OuterRef

from plane.db.models import InventoryItem, InventoryList, Project, ProjectMember, WorkspaceMember

MEMBER_ROLES = (15, 20)


def is_inventory_member(user, workspace_id):
    """Endpoint-level gate: an active workspace Member or Admin. Guests get 403 on every endpoint."""
    return WorkspaceMember.objects.filter(
        workspace_id=workspace_id, member=user, is_active=True, role__in=MEMBER_ROLES
    ).exists()


def visible_projects(user, workspace_id):
    return Project.objects.filter(
        Exists(
            ProjectMember.objects.filter(project=OuterRef("pk"), member=user, is_active=True, role__in=MEMBER_ROLES)
        ),
        Exists(WorkspaceMember.objects.filter(workspace_id=workspace_id, member=user, is_active=True)),
        workspace_id=workspace_id,
        inventory_view=True,
        archived_at__isnull=True,
        deleted_at__isnull=True,
    )


def can_use_project(user, project):
    return visible_projects(user, project.workspace_id).filter(pk=project.pk).exists()


def visible_lists(user, workspace_id):
    return InventoryList.objects.filter(
        workspace_id=workspace_id, project__in=visible_projects(user, workspace_id), deleted_at__isnull=True
    )


def visible_items(user, workspace_id):
    return InventoryItem.objects.filter(
        workspace_id=workspace_id,
        project__in=visible_projects(user, workspace_id),
        inventory_list__deleted_at__isnull=True,
        deleted_at__isnull=True,
    )
