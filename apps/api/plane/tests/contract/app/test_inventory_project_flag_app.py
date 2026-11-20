# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The sidebar reads the lite project list, a hard-coded `.values(...)`, so a project flag that is
not named there never reaches the web app (APLANE-59, brief: Facts about the fork)."""

import pytest
from rest_framework import status

from plane.db.models import Project, ProjectMember


@pytest.mark.contract
@pytest.mark.django_db
def test_the_lite_project_list_carries_inventory_view(session_client, workspace, create_user):
    on = Project.objects.create(name="Home", identifier="HOME", workspace=workspace, inventory_view=True)
    off = Project.objects.create(name="Work", identifier="WORK", workspace=workspace)
    for project in (on, off):
        ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)

    response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/")

    assert response.status_code == status.HTTP_200_OK
    flags = {row["identifier"]: row["inventory_view"] for row in response.json()}
    assert flags == {"HOME": True, "WORK": False}
