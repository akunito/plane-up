# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the sidebar preference rows a brand-new user gets (APLANE-22, B-02).

The first GET of this endpoint bulk-creates a row for every preference key, so whatever it
decides is pinned becomes permanent for that user: the frontend's own default
(DEFAULT_PINNED_WORKSPACE_ITEMS in apps/web/core/hooks/use-navigation-preferences.ts) only
applies while NO row exists, and after this call one always does. Upstream seeded views and
analytics as False, so every new user lost them from the sidebar for good — Diego's account
only looked right because its rows had been corrected by hand in the database.
"""

import pytest

from plane.app.views.workspace.user_preference import DEFAULT_PINNED_PREFERENCE_KEYS
from plane.db.models import WorkspaceUserPreference

URL = "/api/workspaces/{slug}/sidebar-preferences/"

# Must equal DEFAULT_PINNED_WORKSPACE_ITEMS in the web app plus the three upstream already pinned.
# Spelled out rather than derived from the constant, so a change to the constant fails here instead
# of silently redefining what "default" means.
EXPECTED_PINNED = {"drafts", "your_work", "stickies", "views", "analytics"}


@pytest.fixture
def all_keys():
    return {key for key, _ in WorkspaceUserPreference.UserPreferenceKeys.choices}


def test_fresh_user_gets_views_and_analytics_pinned(session_client, workspace, all_keys):
    assert not WorkspaceUserPreference.objects.filter(workspace=workspace).exists()

    response = session_client.get(URL.format(slug=workspace.slug))

    assert response.status_code == 200
    assert set(response.data.keys()) == all_keys, "the first GET must seed a row for every key"
    pinned = {key for key, value in response.data.items() if value["is_pinned"]}
    assert pinned == EXPECTED_PINNED


def test_the_seeded_rows_match_what_is_served(session_client, workspace):
    session_client.get(URL.format(slug=workspace.slug))

    stored = dict(WorkspaceUserPreference.objects.filter(workspace=workspace).values_list("key", "is_pinned"))

    assert {key for key, is_pinned in stored.items() if is_pinned} == EXPECTED_PINNED


def test_a_second_get_does_not_change_or_duplicate_anything(session_client, workspace, all_keys):
    url = URL.format(slug=workspace.slug)
    first = session_client.get(url).data

    second = session_client.get(url).data

    assert first == second
    assert WorkspaceUserPreference.objects.filter(workspace=workspace).count() == len(all_keys)


def test_a_users_own_unpinning_survives_a_later_get(session_client, workspace):
    """The seed must never re-pin a key the user deliberately turned off."""
    url = URL.format(slug=workspace.slug)
    session_client.get(url)
    WorkspaceUserPreference.objects.filter(workspace=workspace, key="views").update(is_pinned=False)

    served = session_client.get(url).data

    assert served["views"]["is_pinned"] is False


def test_the_default_set_is_the_one_the_frontend_expects():
    """Guards the drift that caused B-02: the two lists have to agree."""
    assert {str(key) for key in DEFAULT_PINNED_PREFERENCE_KEYS} == EXPECTED_PINNED
