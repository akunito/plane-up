# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Item photos (APLANE-66): the inventory photo endpoint, and the generic asset views refusing photos.

Storage is mocked: these pin who may do what and which row is THE photo; the presigned POST itself and
the browser upload are exercised on dev (E2E)."""

from unittest.mock import patch

import pytest
from django.conf import settings
from django.utils import timezone
from rest_framework.test import APIClient

from plane.bgtasks.deletion_task import soft_delete_related_objects
from plane.db.models import (
    FileAsset,
    InventoryItem,
    InventoryList,
    Issue,
    Project,
    ProjectMember,
    User,
    WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

PHOTO = FileAsset.INVENTORY_ITEM_PHOTO


def _user(workspace, name, role):
    user = User.objects.create(email=f"{name}@inventory.test", username=name, display_name=name)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def storage():
    with patch("plane.app.views.inventory.S3Storage") as mocked, patch("plane.app.views.asset.v2.S3Storage") as generic:
        s = mocked.return_value
        s.generate_presigned_post.return_value = {"url": "https://storage.test/b", "fields": {"key": "k"}}
        s.get_object_metadata.return_value = {"ContentType": "image/jpeg", "ContentLength": 2048}
        s.generate_presigned_url.return_value = "https://storage.test/b/k?sig=1"
        generic.return_value.generate_presigned_url.return_value = "https://storage.test/generic"
        generic.return_value.generate_presigned_post.return_value = {"url": "u", "fields": {}}
        yield s


@pytest.fixture
def people(workspace, create_user):
    return {
        "alice": create_user,
        "bob": _user(workspace, "bob", 15),
        "gus": _user(workspace, "gus", 5),
        "olga": _user(workspace, "olga", 15),
    }


def _project(workspace, people, name, identifier, members=(("alice", 20), ("bob", 15), ("gus", 5))):
    project = Project.objects.create(
        name=name, identifier=identifier, workspace=workspace, inventory_view=True, network=0
    )
    for who, role in members:
        ProjectMember.objects.create(project=project, member=people[who], role=role)
    return project


@pytest.fixture
def home(workspace, people):
    return _project(workspace, people, "Home", "HOME")


@pytest.fixture
def milk(home):
    lst = InventoryList.objects.create(name="Supermarket", project=home)
    return InventoryItem.objects.create(name="Milk", mode="on_demand", inventory_list=lst, project=home)


def url(workspace, project, item, asset=None):
    base = f"/api/workspaces/{workspace.slug}/projects/{project.pk}/inventory/items/{item.pk}/photo/"
    return f"{base}{asset}/" if asset else base


def _start(client, workspace, project, item, **body):
    return client.post(url(workspace, project, item), {"type": "image/jpeg", "size": 2048, **body}, format="json")


def _photo(client, workspace, project, item):
    """Start and confirm an upload; returns the confirmed asset id."""
    started = _start(client, workspace, project, item)
    assert started.status_code == 200, started.content
    asset_id = started.json()["asset_id"]
    confirmed = client.patch(url(workspace, project, item, asset_id), {}, format="json")
    assert confirmed.status_code == 200, confirmed.content
    assert confirmed.json()["photo"] == asset_id
    return asset_id


# ---------------------------------------------------------------- who may call it


def test_guests_and_outsiders_get_403_on_every_photo_call(workspace, people, home, milk, storage):
    asset_id = _photo(_client(people["alice"]), workspace, home, milk)
    for who in ("gus", "olga"):
        client = _client(people[who])
        calls = [
            ("post", url(workspace, home, milk), {"type": "image/jpeg", "size": 10}),
            ("patch", url(workspace, home, milk, asset_id), {}),
            ("get", url(workspace, home, milk, asset_id), None),
            ("delete", url(workspace, home, milk), None),
        ]
        for method, target, body in calls:
            response = getattr(client, method)(target, body, format="json")
            assert response.status_code == 403, (who, method, response.status_code)
    assert FileAsset.objects.filter(pk=asset_id).exists()


# ---------------------------------------------------------------- starting an upload


@pytest.mark.parametrize(
    "body,field",
    [
        ({"type": "image/svg+xml"}, "type"),
        ({"type": "image/gif"}, "type"),
        ({"type": None}, "type"),
        ({"size": 0}, "size"),
        ({"size": -1}, "size"),
        ({"size": True}, "size"),
        ({"size": "2048"}, "size"),
        ({"size": 1.5}, "size"),
    ],
)
def test_start_refuses_bad_type_or_size(workspace, people, home, milk, storage, body, field):
    response = _start(_client(people["bob"]), workspace, home, milk, **body)
    assert response.status_code == 400 and response.json()["field"] == field
    assert not FileAsset.all_objects.filter(inventory_item=milk).exists()


def test_start_refuses_a_photo_over_the_limit_and_says_the_limit(workspace, people, home, milk, storage):
    response = _start(_client(people["bob"]), workspace, home, milk, size=settings.FILE_SIZE_LIMIT + 1)
    assert response.status_code == 400
    assert response.json() == {"error": "too_large", "field": "size", "limit": settings.FILE_SIZE_LIMIT}
    storage.generate_presigned_post.assert_not_called()


def test_start_creates_a_pending_photo_with_no_client_file_name(workspace, people, home, milk, storage):
    response = _start(_client(people["bob"]), workspace, home, milk, name="IMG_20261121_Bobs-Phone.jpg")
    assert response.status_code == 200
    body = response.json()
    assert body["upload_data"] == {"url": "https://storage.test/b", "fields": {"key": "k"}}
    asset = FileAsset.objects.get(pk=body["asset_id"])
    assert (asset.inventory_item_id, asset.project_id, asset.workspace_id) == (milk.pk, home.pk, workspace.pk)
    assert asset.entity_type == PHOTO and not asset.is_uploaded
    assert asset.asset.name.startswith(f"{workspace.pk}/") and asset.asset.name.endswith("-item-photo.jpg")
    assert "IMG" not in asset.asset.name and asset.attributes["name"] == "photo.jpg"
    storage.generate_presigned_post.assert_called_once_with(
        object_name=asset.asset.name, file_type="image/jpeg", file_size=2048
    )


def test_start_on_an_item_of_another_project_is_404(workspace, people, home, milk, storage):
    other = _project(workspace, people, "Cabin", "CABIN")
    response = _start(_client(people["alice"]), workspace, other, milk)
    assert response.status_code == 404
    assert not FileAsset.all_objects.filter(inventory_item=milk).exists()


def test_start_stops_at_five_pending_uploads(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    for _ in range(5):
        assert _start(client, workspace, home, milk).status_code == 200
    response = _start(client, workspace, home, milk)
    assert response.status_code == 409 and response.json()["error"] == "pending"


def test_a_storage_failure_leaves_no_row(workspace, people, home, milk, storage):
    storage.generate_presigned_post.return_value = None
    response = _start(_client(people["bob"]), workspace, home, milk)
    assert response.status_code == 503
    assert not FileAsset.all_objects.filter(inventory_item=milk).exists()


# ---------------------------------------------------------------- confirming


def test_confirm_refuses_an_object_that_is_not_in_storage(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    asset_id = _start(client, workspace, home, milk).json()["asset_id"]
    storage.get_object_metadata.return_value = None
    response = client.patch(url(workspace, home, milk, asset_id), {}, format="json")
    assert response.status_code == 409 and response.json()["error"] == "not_uploaded"
    assert not FileAsset.objects.get(pk=asset_id).is_uploaded


@pytest.mark.parametrize(
    "meta",
    [
        {"ContentType": "text/html", "ContentLength": 10},
        {"ContentType": "image/jpeg", "ContentLength": settings.FILE_SIZE_LIMIT + 1},
        {"ContentType": "image/jpeg", "ContentLength": 0},
    ],
)
def test_confirm_refuses_an_object_that_is_not_what_was_started(workspace, people, home, milk, storage, meta):
    client = _client(people["bob"])
    asset_id = _start(client, workspace, home, milk).json()["asset_id"]
    storage.get_object_metadata.return_value = meta
    response = client.patch(url(workspace, home, milk, asset_id), {}, format="json")
    assert response.status_code in (400, 409)
    assert not FileAsset.objects.get(pk=asset_id).is_uploaded
    assert (
        client.get(
            f"/api/workspaces/{workspace.slug}/projects/{home.pk}/inventory/lists/{milk.inventory_list_id}/items/"
        ).json()["items"][0]["photo"]
        is None
    )


def test_the_last_confirmed_photo_wins_and_the_earlier_one_is_soft_deleted(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    first = _photo(client, workspace, home, milk)
    second = _photo(client, workspace, home, milk)
    assert first != second
    old = FileAsset.all_objects.get(pk=first)
    assert old.deleted_at is not None and old.is_deleted
    assert FileAsset.objects.get(pk=second).is_uploaded
    assert FileAsset.objects.get(pk=second).size == 2048


def test_a_pending_upload_survives_another_confirmation_and_wins_when_confirmed(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    pending = _start(client, workspace, home, milk).json()["asset_id"]
    _photo(client, workspace, home, milk)
    late = client.patch(url(workspace, home, milk, pending), {}, format="json")
    assert late.status_code == 200 and late.json()["photo"] == pending


def test_confirm_of_another_items_photo_is_404(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    bread = InventoryItem.objects.create(name="Bread", inventory_list=milk.inventory_list, project=home)
    asset_id = _start(client, workspace, home, milk).json()["asset_id"]
    assert client.patch(url(workspace, home, bread, asset_id), {}, format="json").status_code == 404
    assert not FileAsset.objects.get(pk=asset_id).is_uploaded


# ---------------------------------------------------------------- reading, removing, the payload


def test_get_redirects_inline_with_the_type_pinned(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    asset_id = _photo(client, workspace, home, milk)
    response = client.get(url(workspace, home, milk, asset_id))
    assert response.status_code == 302 and response["Location"] == "https://storage.test/b/k?sig=1"
    assert response["Cache-Control"] == "private, max-age=300"
    kwargs = storage.generate_presigned_url.call_args.kwargs
    assert kwargs["disposition"] == "inline" and kwargs["content_type"] == "image/jpeg"


def test_get_of_a_replaced_or_pending_photo_is_404(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    first = _photo(client, workspace, home, milk)
    _photo(client, workspace, home, milk)
    pending = _start(client, workspace, home, milk).json()["asset_id"]
    assert client.get(url(workspace, home, milk, first)).status_code == 404
    assert client.get(url(workspace, home, milk, pending)).status_code == 404


def test_delete_removes_the_photo_from_the_payload(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    asset_id = _photo(client, workspace, home, milk)
    response = client.delete(url(workspace, home, milk))
    assert response.status_code == 200 and response.json()["photo"] is None
    assert FileAsset.all_objects.get(pk=asset_id).deleted_at is not None


def test_every_item_payload_carries_the_photo(workspace, people, home, milk, storage):
    client = _client(people["bob"])
    asset_id = _photo(client, workspace, home, milk)
    InventoryItem.objects.filter(pk=milk.pk).update(needed=True)
    listed = client.get(
        f"/api/workspaces/{workspace.slug}/projects/{home.pk}/inventory/lists/{milk.inventory_list_id}/items/"
    )
    assert listed.json()["items"][0]["photo"] == asset_id
    shopping = client.get(f"/api/workspaces/{workspace.slug}/inventory/shopping-list/").json()
    assert [i["photo"] for i in shopping["items"]] == [asset_id]
    edited = client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{home.pk}/inventory/items/{milk.pk}/",
        {"category": "Dairy"},
        format="json",
    )
    assert edited.json()["photo"] == asset_id


def test_a_forged_photo_row_is_never_the_photo(workspace, people, home, milk, storage):
    # The v1 upload serializer still lets a member write entity_type and project from the body (dark-schema
    # re-review): a row of the photo type without the item key must not become anyone's photo.
    FileAsset.objects.create(
        asset=f"{workspace.pk}/forged.jpg", workspace=workspace, project=home, entity_type=PHOTO, is_uploaded=True
    )
    client = _client(people["bob"])
    listed = client.get(
        f"/api/workspaces/{workspace.slug}/projects/{home.pk}/inventory/lists/{milk.inventory_list_id}/items/"
    )
    assert listed.json()["items"][0]["photo"] is None


def test_moving_an_item_to_another_project_moves_its_photos(workspace, people, home, milk, storage):
    client = _client(people["alice"])
    current = _photo(client, workspace, home, milk)
    cabin = _project(workspace, people, "Cabin", "CABIN")
    target = InventoryList.objects.create(name="Cabin shop", project=cabin)
    moved = client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{home.pk}/inventory/items/{milk.pk}/",
        {"inventory_list": str(target.pk)},
        format="json",
    )
    assert moved.status_code == 200 and moved.json()["photo"] == current
    assert set(FileAsset.all_objects.filter(inventory_item=milk).values_list("project_id", flat=True)) == {cabin.pk}
    assert client.get(url(workspace, cabin, milk, current)).status_code == 302


def test_deleting_the_list_soft_deletes_its_items_photos(workspace, people, home, milk, storage):
    asset_id = _photo(_client(people["alice"]), workspace, home, milk)
    lst = milk.inventory_list
    lst.deleted_at = timezone.now()
    lst.save()
    soft_delete_related_objects("db", "inventorylist", lst.pk)
    assert FileAsset.all_objects.get(pk=asset_id).deleted_at is not None


# ---------------------------------------------------------------- the generic asset views refuse photos


def test_no_generic_asset_view_serves_changes_or_copies_a_photo(workspace, people, home, milk, storage):
    alice = people["alice"]
    client = _client(alice)
    asset_id = _photo(client, workspace, home, milk)
    s, p = workspace.slug, home.pk
    v2 = f"/api/assets/v2/workspaces/{s}"
    reads = [
        f"{v2}/{asset_id}/",
        f"{v2}/projects/{p}/{asset_id}/",
        f"{v2}/download/{asset_id}/",
        f"{v2}/projects/{p}/download/{asset_id}/",
        f"/api/assets/v2/static/{asset_id}/",
    ]
    for target in reads:
        response = client.get(target)
        assert response.status_code in (400, 403, 404), (target, response.status_code)
    assert client.get(f"{v2}/check/{asset_id}/").json() == {"exists": False}
    for method, target in (
        ("patch", f"{v2}/{asset_id}/"),
        ("delete", f"{v2}/{asset_id}/"),
        ("patch", f"{v2}/projects/{p}/{asset_id}/"),
        ("delete", f"{v2}/projects/{p}/{asset_id}/"),
    ):
        response = getattr(client, method)(target, {"attributes": {"name": "x"}}, format="json")
        assert response.status_code in (403, 404), (method, target, response.status_code)
    duplicated = client.post(
        f"{v2}/duplicate-assets/{asset_id}/", {"entity_type": "ISSUE_DESCRIPTION", "project_id": str(p)}, format="json"
    )
    assert duplicated.status_code in (403, 404)

    # Bulk association: alice's own photo listed next to her own description image must not be re-pointed.
    issue = Issue.objects.create(name="Fix", project=home, workspace=workspace)
    description = FileAsset.objects.create(
        asset=f"{workspace.pk}/desc.png",
        workspace=workspace,
        project=home,
        entity_type="ISSUE_DESCRIPTION",
        created_by=alice,
        is_uploaded=True,
    )
    # update(), not create(created_by=...): BaseModel.save() overwrites it with the request user (none here).
    FileAsset.objects.filter(pk__in=[asset_id, description.pk]).update(created_by=alice)
    client.post(f"{v2}/projects/{p}/{issue.pk}/bulk/", {"asset_ids": [str(description.pk), asset_id]}, format="json")
    assert FileAsset.objects.get(pk=description.pk).issue_id == issue.pk, "the bulk call itself worked"
    assert FileAsset.objects.get(pk=asset_id).issue_id is None

    # Restore of a replaced photo would make two current photos.
    replaced = asset_id
    _photo(client, workspace, home, milk)
    assert client.post(f"{v2}/restore/{replaced}/").status_code in (403, 404)
    assert FileAsset.all_objects.get(pk=replaced).deleted_at is not None

    current = FileAsset.objects.get(inventory_item=milk, deleted_at__isnull=True, is_uploaded=True)
    assert current.attributes["name"] == "photo.jpg" and not current.is_deleted
