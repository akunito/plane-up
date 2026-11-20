# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The shopping-list Home widget (APLANE-63, plan phase 5): its preference row exists and is listed only
for a viewer who can see a project with inventory on, so every other Home and manage dialog is unchanged;
it is first for a new user and for one who had reordered widgets (Home orders by sort_order descending)."""

import pytest
from rest_framework.test import APIClient

from plane.db.models import Project, ProjectMember, User, WorkspaceHomePreference, WorkspaceMember

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

KEY = "shopping_list"


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _home(user, slug):
    response = _client(user).get(f"/api/workspaces/{slug}/home-preferences/")
    assert response.status_code == 200
    return {row["key"]: row for row in response.json()}


def _user(workspace, name, role):
    user = User.objects.create(email=f"{name}@home.test", username=name, display_name=name)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def test_without_inventory_home_is_unchanged_and_no_row_is_created(workspace, create_user):
    Project.objects.create(name="Work", identifier="WORK", workspace=workspace)
    rows = _home(create_user, workspace.slug)
    assert set(rows) == {"quick_links", "recents", "my_stickies"}
    assert not WorkspaceHomePreference.objects.filter(user=create_user, key=KEY).exists()


def test_a_member_of_an_inventory_project_gets_the_widget_first_new_or_reordered(workspace, create_user):
    home = Project.objects.create(name="Home", identifier="HOME", workspace=workspace, inventory_view=True)
    ProjectMember.objects.create(project=home, member=create_user, role=20)
    rows = _home(create_user, workspace.slug)
    assert rows[KEY]["is_enabled"] is True
    assert rows[KEY]["sort_order"] > max(r["sort_order"] for k, r in rows.items() if k != KEY)

    # Someone who had reordered before inventory existed: still first, once; then their order holds.
    bob = _user(workspace, "bob", 15)
    ProjectMember.objects.create(project=home, member=bob, role=15)
    WorkspaceHomePreference.objects.create(workspace=workspace, user=bob, key="recents", sort_order=5000)
    WorkspaceHomePreference.objects.create(workspace=workspace, user=bob, key="quick_links", sort_order=4000)
    WorkspaceHomePreference.objects.create(workspace=workspace, user=bob, key="my_stickies", sort_order=3000)
    rows = _home(bob, workspace.slug)
    assert rows[KEY]["sort_order"] > 5000
    WorkspaceHomePreference.objects.filter(user=bob, key=KEY).update(sort_order=10)
    assert _home(bob, workspace.slug)[KEY]["sort_order"] == 10
    assert WorkspaceHomePreference.objects.filter(user=bob, key=KEY).count() == 1


def test_guests_outsiders_and_people_who_lost_access_do_not_see_it(workspace, create_user):
    home = Project.objects.create(name="Home", identifier="HOME", workspace=workspace, inventory_view=True)
    gus = _user(workspace, "gus", 5)
    ProjectMember.objects.create(project=home, member=gus, role=5)
    olga = _user(workspace, "olga", 15)  # workspace member, not in the project
    for user in (gus, olga):
        assert KEY not in _home(user, workspace.slug)
    ProjectMember.objects.create(project=home, member=create_user, role=20)
    assert KEY in _home(create_user, workspace.slug)
    Project.objects.filter(pk=home.pk).update(inventory_view=False)
    # The row stays (the person's order and toggle survive), but neither Home nor the dialog lists it.
    assert KEY not in _home(create_user, workspace.slug)
    assert WorkspaceHomePreference.objects.filter(user=create_user, key=KEY).exists()
