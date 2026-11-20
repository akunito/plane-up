# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared fixtures for the inventory engine tests (APLANE-60). A household: alice (workspace admin),
bob (member), gus (guest) and olga (workspace member who is not in the project)."""

import uuid

import pytest
from django.utils import timezone

from plane.app.inventory import engine
from plane.db.models import InventoryItem, InventoryList, Project, ProjectMember, User, WorkspaceMember


def _user(name):
    return User.objects.create(
        email=f"{name}@inventory.test", username=name, first_name=name.title(), display_name=name
    )


@pytest.fixture
def alice(create_user):
    return create_user  # the workspace fixture makes her a workspace admin


@pytest.fixture
def bob(db, workspace):
    user = _user("bob")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def gus(db, workspace):
    user = _user("gus")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=5)
    return user


@pytest.fixture
def olga(db, workspace):
    user = _user("olga")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def home(workspace, alice, bob, gus):
    project = Project.objects.create(
        name="Home", identifier="HOME", workspace=workspace, inventory_view=True, network=0
    )
    ProjectMember.objects.create(project=project, member=alice, role=20)
    ProjectMember.objects.create(project=project, member=bob, role=15)
    ProjectMember.objects.create(project=project, member=gus, role=5)
    return project


@pytest.fixture
def groceries(home):
    return InventoryList.objects.create(name="Supermarket", project=home)


@pytest.fixture
def make_item(groceries):
    def _make(name="Milk", mode="on_demand", inventory_list=None, **state):
        lst = inventory_list or groceries
        defaults = {
            "on_demand": {"needed": True},
            "level": {"level": "low"},
            "units": {"quantity": 0, "min_quantity": 1},
            "pinned": {},
        }[mode]
        return InventoryItem.objects.create(
            name=name, mode=mode, inventory_list=lst, project=lst.project, **{**defaults, **state}
        )

    return _make


@pytest.fixture
def ctx(workspace):
    def _ctx(user, source="web", now=None):
        return engine.Context(user=user, workspace_id=workspace.pk, source=source, now=now or timezone.now())

    return _ctx


def op(name, item, args=None, base_rev=None, queue=None, client_op_id=None, age_ms=0, v=1):
    raw = {
        "v": v,
        "client_op_id": str(client_op_id or uuid.uuid4()),
        "queue_id": str(queue) if queue else None,
        "target": str(item.pk) if hasattr(item, "pk") else str(item),
        "op": name,
        "args": args or {},
        "age_ms": age_ms,
    }
    if base_rev is not None:
        raw["base_rev"] = base_rev
    return raw


def fresh(item):
    item.refresh_from_db()
    return item
