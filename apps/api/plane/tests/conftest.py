# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from rest_framework.test import APIClient
from pytest_django.fixtures import django_db_setup

from plane.db.models import User, Workspace, WorkspaceMember
from plane.db.models.api import APIToken


@pytest.fixture(scope="session")
def django_db_setup(django_db_setup):  # noqa: F811
    """Set up the Django database for the test session"""
    pass


# Hostnames whose cache is a throwaway. An exact hostname and not a substring: the LOCATION is
# the whole REDIS_URL, credentials included, and a failing `assert "x" not in location` prints
# both operands — pytest rewrites asserts in conftest.py — so a blocklist on the raw URL leaks the
# password into the L2 log, which plane-deploy forwards to Telegram. Residual risk, accepted: a
# live instance reachable as localhost would pass. The real invariant is CACHES pointing at the
# harness's own valkey, which docker-compose-test.yml does.
_THROWAWAY_CACHE_HOSTS = frozenset({"test-redis", "localhost", "127.0.0.1", "::1"})


@pytest.fixture(scope="session", autouse=True)
def _cache_is_throwaway():
    """
    Session-scoped on purpose: `cache.clear()` is a FLUSHDB on django-redis, and the suite calls it
    from a dozen places besides the fixture below (test_authentication.py clears in a module-level
    autouse fixture and inside tests). A function-scoped check would only happen to run first.
    """
    from urllib.parse import urlparse

    from django.conf import settings

    locations = settings.CACHES.get("default", {}).get("LOCATION", "")
    for one in [locations] if isinstance(locations, str) else list(locations):
        host = urlparse(str(one)).hostname or ""
        assert host in _THROWAWAY_CACHE_HOSTS, (
            f"the cache host {host!r} is not a throwaway one and the suite FLUSHDBs it; "
            f"point CACHES['default']['LOCATION'] at one of {sorted(_THROWAWAY_CACHE_HOSTS)}"
        )


@pytest.fixture(autouse=True)
def _reset_throttle_cache():
    """
    Every throttle in this codebase counts in the shared cache, and the harness points that
    cache at one valkey for the whole run. `api_token` always mints the same literal token, so
    ApiKeyRateThrottle buckets every external-API test into one `api_key:test-api-token-12345`
    key: once the suite grew past 60 of them in a minute, later tests got 429 instead of their
    answer. The auth-throttle tests have the mirror problem — they patch the rate down to 1-2
    and expect the first call to pass, which an already-full per-IP bucket denies.

    Clearing before each test makes the bucket per-test, which is what every one of them assumes.
    """
    from django.core.cache import cache

    cache.clear()
    yield


@pytest.fixture
def api_client():
    """Return an unauthenticated API client"""
    return APIClient()


@pytest.fixture
def user_data():
    """Return standard user data for tests"""
    return {
        "email": "test@plane.so",
        "password": "test-password",
        "first_name": "Test",
        "last_name": "User",
    }


@pytest.fixture
def create_user(db, user_data):
    """Create and return a user instance"""
    user = User.objects.create(
        email=user_data["email"],
        first_name=user_data["first_name"],
        last_name=user_data["last_name"],
    )
    user.set_password(user_data["password"])
    user.save()
    return user


@pytest.fixture
def api_token(db, create_user):
    """Create and return an API token for testing the external API"""
    token = APIToken.objects.create(
        user=create_user,
        label="Test API Token",
        token="test-api-token-12345",
    )
    return token


@pytest.fixture
def api_key_client(api_client, api_token):
    """Return an API key authenticated client for external API testing"""
    api_client.credentials(HTTP_X_API_KEY=api_token.token)
    return api_client


@pytest.fixture
def session_client(api_client, create_user):
    """Return a session authenticated API client for app API testing, which is what plane.app uses"""
    api_client.force_authenticate(user=create_user)
    return api_client


@pytest.fixture
def create_bot_user(db):
    """Create and return a bot user instance"""
    from uuid import uuid4

    unique_id = uuid4().hex[:8]
    user = User.objects.create(
        email=f"bot-{unique_id}@plane.so",
        username=f"bot_user_{unique_id}",
        first_name="Bot",
        last_name="User",
        is_bot=True,
    )
    user.set_password("bot@123")
    user.save()
    return user


@pytest.fixture
def api_token_data():
    """Return sample API token data for testing"""
    from django.utils import timezone
    from datetime import timedelta

    return {
        "label": "Test API Token",
        "description": "Test description for API token",
        "expired_at": (timezone.now() + timedelta(days=30)).isoformat(),
    }


@pytest.fixture
def create_api_token_for_user(db, create_user):
    """Create and return an API token for a specific user"""
    return APIToken.objects.create(
        label="Test Token",
        description="Test token description",
        user=create_user,
        user_type=0,
    )


@pytest.fixture
def plane_server(live_server):
    """
    Renamed version of live_server fixture to avoid name clashes.
    Returns a live Django server for testing HTTP requests.
    """
    return live_server


@pytest.fixture
def workspace(create_user):
    """
    Create a new workspace and return the
    corresponding Workspace model instance.
    """
    # Create the workspace using the model
    created_workspace = Workspace.objects.create(
        name="Test Workspace",
        owner=create_user,
        slug="test-workspace",
    )

    WorkspaceMember.objects.create(workspace=created_workspace, member=create_user, role=20)

    return created_workspace
