"""APLANE-71: the session middleware picks the ADMIN cookie only under the /api/instances/ mount. It used a
substring test ("instances" in the path), and a workspace slug like instances-team is legal, so such a
workspace's requests read the admin cookie: members got 401, or acted as the admin when the browser also held
an admin session."""

import uuid
from importlib import import_module

import pytest
from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.http import HttpResponse
from django.test import Client
from django.utils import timezone

from plane.authentication.middleware.session import SessionMiddleware, is_admin_path
from plane.db.models import User, Workspace, WorkspaceMember
from plane.license.models import Instance, InstanceAdmin

SLUG = "instances-team"


def session_for(user):
    store = import_module(settings.SESSION_ENGINE).SessionStore()
    store[SESSION_KEY] = str(user.pk)
    store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
    store[HASH_SESSION_KEY] = user.get_session_auth_hash()
    store.create()
    return store.session_key


@pytest.fixture
def setup(db, create_user):
    instance = Instance.objects.create(
        instance_name="Test Instance",
        instance_id=str(uuid.uuid4()),
        current_version="1.0.0",
        domain="http://localhost:8000",
        last_checked_at=timezone.now(),
        is_setup_done=True,
    )
    admin = User.objects.create(email="admin@plane.so", username="instance-admin", first_name="Admin")
    InstanceAdmin.objects.create(user=admin, instance=instance, role=20, is_verified=True)
    ws = Workspace.objects.create(name="Instances team", owner=create_user, slug=SLUG)
    WorkspaceMember.objects.create(workspace=ws, member=create_user, role=20)
    return create_user, admin


@pytest.mark.django_db
def test_a_member_of_a_workspace_named_instances_team_reaches_it(setup):
    member, _ = setup
    client = Client()
    client.cookies[settings.SESSION_COOKIE_NAME] = session_for(member)
    assert client.get(f"/api/workspaces/{SLUG}/").status_code == 200  # was 401: the admin cookie was read


@pytest.mark.django_db
def test_with_both_cookies_the_workspace_request_is_the_member_not_the_admin(setup):
    member, admin = setup
    client = Client()
    client.cookies[settings.SESSION_COOKIE_NAME] = session_for(member)
    client.cookies[settings.ADMIN_SESSION_COOKIE_NAME] = session_for(admin)
    # The admin is not a member: had the request run as the admin, it would be refused.
    assert client.get(f"/api/workspaces/{SLUG}/").status_code == 200
    assert client.get(f"/api/workspaces/{SLUG}/workspace-members/me/").json()["member"] == str(member.pk)


@pytest.mark.django_db
def test_the_admin_api_still_reads_only_the_admin_cookie(setup):
    member, admin = setup
    admin_client = Client()
    admin_client.cookies[settings.ADMIN_SESSION_COOKIE_NAME] = session_for(admin)
    assert admin_client.get("/api/instances/admins/me/").status_code == 200
    web_only = Client()
    web_only.cookies[settings.SESSION_COOKIE_NAME] = session_for(admin)  # the admin's WEB session is not enough
    assert web_only.get("/api/instances/admins/me/").status_code == 401  # anonymous: the web cookie is not read there


def _respond(rf, path, cookies, write):
    """The middleware alone around a view that writes the session (sign-in) or flushes it (sign-out: logout()
    flushes, and only a flushed session is empty while a key is present)."""

    def view(request):
        if write:
            request.session["k"] = "v"
        else:
            request.session.flush()
        return HttpResponse()

    request = rf.get(path)
    request.COOKIES.update(cookies)
    mw = SessionMiddleware(view)
    mw.process_request(request)
    response = view(request)
    return mw.process_response(request, response)


@pytest.mark.django_db
def test_the_response_sets_the_cookie_of_its_path(rf):
    # process_response decides the cookie name on its own: it must agree with process_request.
    admin = _respond(rf, "/api/instances/admins/sign-in/", {}, write=True).cookies
    assert settings.ADMIN_SESSION_COOKIE_NAME in admin and settings.SESSION_COOKIE_NAME not in admin
    assert admin[settings.ADMIN_SESSION_COOKIE_NAME]["max-age"] == settings.ADMIN_SESSION_COOKIE_AGE
    web = _respond(rf, f"/api/workspaces/{SLUG}/", {}, write=True).cookies
    assert settings.SESSION_COOKIE_NAME in web and settings.ADMIN_SESSION_COOKIE_NAME not in web
    # The two ages differ, so the max-age checks tell the cookies apart.
    assert settings.SESSION_COOKIE_AGE != settings.ADMIN_SESSION_COOKIE_AGE
    assert web[settings.SESSION_COOKIE_NAME]["max-age"] == settings.SESSION_COOKIE_AGE


@pytest.mark.django_db
def test_an_empty_session_deletes_only_the_cookie_of_its_path(rf):
    both = {settings.SESSION_COOKIE_NAME: "a" * 32, settings.ADMIN_SESSION_COOKIE_NAME: "b" * 32}
    out = _respond(rf, f"/api/workspaces/{SLUG}/", both, write=False).cookies
    assert out[settings.SESSION_COOKIE_NAME]["max-age"] == 0 and settings.ADMIN_SESSION_COOKIE_NAME not in out
    out = _respond(rf, "/api/instances/admins/sign-out/", both, write=False).cookies
    assert out[settings.ADMIN_SESSION_COOKIE_NAME]["max-age"] == 0 and settings.SESSION_COOKIE_NAME not in out


@pytest.mark.parametrize(
    "path,admin",
    [
        ("/api/instances/", True),
        ("/api/instances/admins/sign-in/", True),
        ("/api/workspaces/instances-team/projects/", False),
        ("/api/workspaces/myinstances/", False),
        ("/api/users/me/", False),
        ("/god-mode/instances/", False),
    ],
)
def test_only_the_mount_is_an_admin_path(rf, path, admin):
    assert is_admin_path(rf.get(path)) is admin
