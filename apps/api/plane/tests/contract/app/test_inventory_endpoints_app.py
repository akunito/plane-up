# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Inventory endpoints (APLANE-60): permissions, leaks, the derived list, items, preferences."""

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.bgtasks.inventory_task import prune_inventory_events
from plane.db.models import (
    APIToken,
    InventoryEvent,
    InventoryItem,
    InventoryList,
    InventoryOrder,
    Project,
    ProjectMember,
    User,
    WorkspaceMember,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def _user(workspace, name, role):
    user = User.objects.create(email=f"{name}@inventory.test", username=name, display_name=name)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    return user


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def people(workspace, create_user):
    return {
        "alice": create_user,
        "bob": _user(workspace, "bob", 15),
        "gus": _user(workspace, "gus", 5),
        "olga": _user(workspace, "olga", 15),
    }


@pytest.fixture
def home(workspace, people):
    project = Project.objects.create(
        name="Home", identifier="HOME", workspace=workspace, inventory_view=True, network=0
    )
    for name, role in (("alice", 20), ("bob", 15), ("gus", 5)):
        ProjectMember.objects.create(project=project, member=people[name], role=role)
    return project


@pytest.fixture
def groceries(home):
    return InventoryList.objects.create(name="Supermarket", project=home)


def _item(lst, name, mode, **state):
    return InventoryItem.objects.create(name=name, mode=mode, inventory_list=lst, project=lst.project, **state)


def ws(slug, path):
    return f"/api/workspaces/{slug}/inventory/{path}"


def proj(slug, project, path):
    return f"/api/workspaces/{slug}/projects/{project.pk}/inventory/{path}"


# ---------------------------------------------------------------- who may call what


def test_guests_get_403_on_every_endpoint(workspace, people, home, groceries):
    item = _item(groceries, "Milk", "on_demand", needed=True)
    client = _client(people["gus"])
    calls = [
        ("get", ws(workspace.slug, "shopping-list/"), None),
        ("post", ws(workspace.slug, "ops/"), {"ops": []}),
        ("get", ws(workspace.slug, "suggestions/?q=mi"), None),
        ("get", ws(workspace.slug, "preferences/"), None),
        ("put", ws(workspace.slug, "preferences/"), {}),
        ("get", proj(workspace.slug, home, "lists/"), None),
        ("post", proj(workspace.slug, home, "lists/"), {"name": "x"}),
        ("patch", proj(workspace.slug, home, f"lists/{groceries.pk}/"), {"name": "x"}),
        ("delete", proj(workspace.slug, home, f"lists/{groceries.pk}/"), None),
        ("get", proj(workspace.slug, home, f"lists/{groceries.pk}/items/"), None),
        ("post", proj(workspace.slug, home, f"lists/{groceries.pk}/items/"), {"name": "x"}),
        ("patch", proj(workspace.slug, home, f"items/{item.pk}/"), {"category": "x"}),
        ("delete", proj(workspace.slug, home, f"items/{item.pk}/"), None),
    ]
    for method, url, body in calls:
        response = getattr(client, method)(url, body, format="json")
        assert response.status_code == 403, (method, url, response.status_code)
    assert InventoryItem.objects.filter(pk=item.pk).exists() and InventoryList.objects.filter(pk=groceries.pk).exists()


def test_a_workspace_member_outside_the_project_sees_nothing_and_may_change_nothing(workspace, people, home, groceries):
    _item(groceries, "Milk", "on_demand", needed=True)
    client = _client(people["olga"])
    assert client.get(ws(workspace.slug, "shopping-list/")).json()["items"] == []
    assert client.get(proj(workspace.slug, home, "lists/")).status_code == 403
    assert client.post(proj(workspace.slug, home, "lists/"), {"name": "Mine"}, format="json").status_code == 403


def test_project_endpoints_refuse_a_project_with_inventory_off(workspace, people, home):
    Project.objects.filter(pk=home.pk).update(inventory_view=False)
    assert _client(people["alice"]).get(proj(workspace.slug, home, "lists/")).status_code == 403


# ---------------------------------------------------------------- leaks


def test_the_to_buy_list_and_suggestions_show_only_projects_the_viewer_is_in(workspace, people, home, groceries):
    _item(groceries, "Milk", "on_demand", needed=True)
    secret = Project.objects.create(name="Me", identifier="ME", workspace=workspace, inventory_view=True, network=0)
    ProjectMember.objects.create(project=secret, member=people["alice"], role=20)
    _item(InventoryList.objects.create(name="Supplements", project=secret), "Magnesium", "on_demand", needed=True)
    public = Project.objects.create(name="Open", identifier="OPEN", workspace=workspace, inventory_view=True, network=2)
    ProjectMember.objects.create(project=public, member=people["alice"], role=20)
    _item(InventoryList.objects.create(name="Garden", project=public), "Mulch", "on_demand", needed=True)

    def names(user, path):
        body = _client(people[user]).get(ws(workspace.slug, path)).json()
        return sorted(i["name"] for i in body["items"])

    assert names("alice", "shopping-list/") == ["Magnesium", "Milk", "Mulch"]
    assert names("bob", "shopping-list/") == ["Milk"], "a secret project and a public one bob has not joined"
    assert names("bob", "suggestions/?q=m") == ["Milk"]


# ---------------------------------------------------------------- the to-buy list


def test_the_to_buy_list_counter_and_on_the_way(workspace, people, home, groceries):
    _item(groceries, "Bread", "pinned")
    _item(groceries, "Milk", "on_demand", needed=True)
    _item(groceries, "Salt", "on_demand", needed=False)
    _item(groceries, "Rice", "level", level="low")
    _item(groceries, "Water", "units", quantity=1, min_quantity=2, restock_to=6)
    ordered = _item(groceries, "Coffee", "level", level="out")
    old = InventoryOrder.objects.create(item=ordered, project=home, ordered_at=timezone.now())
    InventoryOrder.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=11))
    body = _client(people["bob"]).get(ws(workspace.slug, "shopping-list/")).json()
    to_buy = {i["name"]: i["to_buy"] for i in body["items"]}
    assert to_buy == {"Bread": 1, "Milk": 1, "Rice": 1, "Water": 5}
    assert body["count"] == 3, "pinned rows do not count"
    assert [(o["item_name"], o["overdue"]) for o in body["on_the_way"]] == [("Coffee", True)]


def test_the_to_buy_list_stays_within_a_query_budget(workspace, people, home, groceries, django_assert_max_num_queries):
    InventoryItem.objects.bulk_create(
        InventoryItem(
            name=f"Item {i}",
            name_normalised=f"item {i}",
            mode="units",
            quantity=0,
            min_quantity=1,
            inventory_list=groceries,
            project=home,
            workspace=home.workspace,
        )
        for i in range(500)
    )
    client = _client(people["bob"])
    with django_assert_max_num_queries(12):
        body = client.get(ws(workspace.slug, "shopping-list/")).json()
    assert len(body["items"]) == 500


# ---------------------------------------------------------------- operations over HTTP


def test_ops_takes_at_most_100_operations(workspace, people, home):
    client = _client(people["bob"])
    assert client.post(ws(workspace.slug, "ops/"), {"ops": [{}] * 101}, format="json").status_code == 400
    assert client.post(ws(workspace.slug, "ops/"), {"ops": []}, format="json").status_code == 400


def test_an_api_key_request_is_recorded_with_source_api(workspace, people, home, groceries):
    item = _item(groceries, "Milk", "on_demand", needed=True)
    token = APIToken.objects.create(user=people["bob"], label="mcp", token="inventory-test-key-1")
    client = APIClient()
    client.credentials(HTTP_X_API_KEY=token.token)
    order_id = str(uuid.uuid4())
    body = {
        "ops": [
            {
                "v": 1,
                "client_op_id": str(uuid.uuid4()),
                "target": str(item.pk),
                "op": "mark_ordered",
                "args": {"order_id": order_id},
            }
        ]
    }
    response = client.post(ws(workspace.slug, "ops/"), body, format="json")
    assert response.status_code == 200 and response.json()["results"][0]["result"] == "applied"
    assert InventoryOrder.objects.get(pk=order_id).source == "api"
    assert InventoryEvent.objects.get(order_id=order_id).source == "api"


# ---------------------------------------------------------------- items


@pytest.mark.parametrize(
    "mode,check",
    [
        ("on_demand", lambda b: b["needed"] is True),
        ("level", lambda b: b["level"] == "low"),
        ("units", lambda b: (b["quantity"], b["min_quantity"]) == (0, 1)),
        ("pinned", lambda b: b["mode"] == "pinned"),
    ],
)
def test_a_new_item_goes_onto_the_to_buy_list_at_once(mode, check, workspace, people, home, groceries):
    response = _client(people["bob"]).post(
        proj(workspace.slug, home, f"lists/{groceries.pk}/items/"), {"name": "Milk", "mode": mode}, format="json"
    )
    assert response.status_code == 201, response.json()
    body = response.json()
    assert check(body) and body["to_buy"] >= 1 and body["rev"] == 0


def test_a_duplicate_name_offers_the_existing_item(workspace, people, home, groceries):
    existing = _item(groceries, "Oat milk", "on_demand", needed=True)
    response = _client(people["bob"]).post(
        proj(workspace.slug, home, f"lists/{groceries.pk}/items/"), {"name": "  OAT   milk "}, format="json"
    )
    assert response.status_code == 409 and response.json()["item"]["id"] == str(existing.pk)


def test_editing_an_item_cannot_write_state_and_does_not_advance_the_revision(workspace, people, home, groceries):
    item = _item(groceries, "Water", "units", quantity=1, min_quantity=2)
    client = _client(people["bob"])
    url = proj(workspace.slug, home, f"items/{item.pk}/")
    assert client.patch(url, {"quantity": 9}, format="json").status_code == 400
    assert client.patch(url, {"mode": "pinned"}, format="json").status_code == 400
    assert client.patch(url, {"restock_to": 1}, format="json").status_code == 400, "below the stored minimum"
    response = client.patch(url, {"restock_to": 6, "category": "Drinks", "external_id": ""}, format="json")
    assert response.status_code == 200
    item.refresh_from_db()
    assert (item.restock_to, item.category, item.state_rev, item.quantity, item.external_id) == (
        6,
        "Drinks",
        0,
        1,
        None,
    )


def test_moving_an_item_to_another_project_takes_its_orders_and_history(workspace, people, home, groceries):
    item = _item(groceries, "Vitamin D", "on_demand", needed=True)
    order = InventoryOrder.objects.create(item=item, project=home, ordered_at=timezone.now())
    event = InventoryEvent.objects.create(
        client_op_id=uuid.uuid4(),
        workspace=home.workspace,
        project=home,
        item=item,
        op="buy",
        result="applied",
        occurred_at=timezone.now(),
    )
    me = Project.objects.create(name="Me", identifier="ME", workspace=workspace, inventory_view=True, network=0)
    ProjectMember.objects.create(project=me, member=people["alice"], role=20)
    target = InventoryList.objects.create(name="Supplements", project=me)
    response = _client(people["alice"]).patch(
        proj(workspace.slug, home, f"items/{item.pk}/"), {"inventory_list": str(target.pk)}, format="json"
    )
    assert response.status_code == 200, response.json()
    for row in (item, order, event):
        row.refresh_from_db()
        assert row.project_id == me.pk, type(row).__name__
    # bob is not in "Me": he cannot move anything there.
    other = _item(groceries, "Bread", "pinned")
    response = _client(people["bob"]).patch(
        proj(workspace.slug, home, f"items/{other.pk}/"), {"inventory_list": str(target.pk)}, format="json"
    )
    assert response.status_code == 403


# ---------------------------------------------------------------- preferences and pruning


def test_preferences_are_per_person(workspace, people, home):
    alice, bob = _client(people["alice"]), _client(people["bob"])
    url = ws(workspace.slug, "preferences/")
    assert alice.get(url).json() == {"category_order": [], "default_grouping": "category"}
    assert (
        alice.put(url, {"category_order": ["Dairy", "Bakery"], "default_grouping": "store"}, format="json").status_code
        == 200
    )
    assert alice.put(url, {"default_grouping": "colour"}, format="json").status_code == 400
    assert alice.get(url).json()["category_order"] == ["Dairy", "Bakery"]
    assert bob.get(url).json()["category_order"] == []


def test_events_older_than_90_days_are_pruned(workspace, home, groceries):
    item = _item(groceries, "Milk", "pinned")
    old, recent = uuid.uuid4(), uuid.uuid4()
    for client_op_id in (old, recent):
        InventoryEvent.objects.create(
            client_op_id=client_op_id,
            workspace=workspace,
            item=item,
            op="buy",
            result="applied",
            occurred_at=timezone.now(),
        )
    InventoryEvent.objects.filter(client_op_id=old).update(received_at=timezone.now() - timedelta(days=91))
    assert prune_inventory_events() == 1
    assert list(InventoryEvent.objects.values_list("client_op_id", flat=True)) == [recent]
