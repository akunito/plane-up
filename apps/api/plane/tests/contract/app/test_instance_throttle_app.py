"""APLANE-70: GET /api/instances/ is read on every page load of the web app, and the session middleware reads
the ADMIN cookie on any path containing "instances", so a signed-in user reaches it as anonymous. It has its
own budget (InstanceReadThrottle), not the 30/minute anonymous one."""

import uuid
from unittest.mock import patch

import pytest
from django.test import Client
from django.utils import timezone

from plane.license.models import Instance
from plane.throttles.instance import InstanceReadThrottle


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        instance_name="Test Instance",
        instance_id=str(uuid.uuid4()),
        current_version="1.0.0",
        domain="http://localhost:8000",
        last_checked_at=timezone.now(),
        is_setup_done=True,
    )


@pytest.mark.django_db
def test_a_signed_in_web_session_loads_the_instance_more_than_30_times_a_minute(instance, create_user):
    client = Client()
    client.force_login(create_user)  # the web app's session cookie, not the admin one
    assert client.get("/api/users/me/").status_code == 200
    codes = [client.get("/api/instances/").status_code for _ in range(40)]
    assert codes == [200] * 40


@pytest.mark.django_db
def test_the_instance_read_still_has_a_budget(instance):
    client = Client()
    # The rate comes from THROTTLE_RATES at construction (no class attribute to patch).
    with patch.dict(InstanceReadThrottle.THROTTLE_RATES, {"instance_read": "2/minute"}):
        codes = [client.get("/api/instances/").status_code for _ in range(3)]
    assert codes == [200, 200, 429]
