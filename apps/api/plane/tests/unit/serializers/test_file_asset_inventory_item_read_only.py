# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""FileAsset.inventory_item (APLANE-66) is never taken from a request body.

Every FileAsset serializer is `fields = "__all__"`, and three views save one straight from
request.data (v1 `workspaces/<slug>/file-assets/` and `users/file-assets/`, and
`issue-attachments/`, which guests may call). DRF resolves the key against every item in the
database, so a writable field would let any member hang a file on an item of any project.
The serializers are found by scanning, so a new one cannot slip past.
"""

import importlib

import pytest
from rest_framework import serializers

from plane.db.models import FileAsset, InventoryItem, InventoryList, Project

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

MODULES = ("plane.app.serializers", "plane.api.serializers", "plane.space.serializer")


def _all_subclasses(cls):
    for sub in cls.__subclasses__():
        yield sub
        yield from _all_subclasses(sub)


def _file_asset_serializers():
    for name in MODULES:
        importlib.import_module(name)
    found = {
        cls
        for cls in _all_subclasses(serializers.ModelSerializer)
        if getattr(getattr(cls, "Meta", None), "model", None) is FileAsset
        and cls.__module__.startswith(MODULES)
        and "inventory_item" in cls().fields
    }
    return sorted(found, key=lambda c: f"{c.__module__}.{c.__qualname__}")


SERIALIZERS = _file_asset_serializers()


@pytest.fixture
def item(workspace):
    project = Project.objects.create(name="Home", identifier="HOME", workspace=workspace)
    lst = InventoryList.objects.create(name="Supermarket", project=project)
    return InventoryItem.objects.create(name="Milk", inventory_list=lst, project=project)


def test_the_scan_finds_the_known_serializers():
    names = {f"{c.__module__}.{c.__qualname__}" for c in SERIALIZERS}
    assert {
        "plane.app.serializers.asset.FileAssetSerializer",
        "plane.app.serializers.issue.IssueAttachmentSerializer",
        "plane.api.serializers.asset.FileAssetSerializer",
        "plane.api.serializers.issue.IssueAttachmentSerializer",
        "plane.space.serializer.issue.IssueAttachmentSerializer",
    } <= names


@pytest.mark.parametrize("serializer_cls", SERIALIZERS, ids=lambda c: f"{c.__module__}.{c.__qualname__}")
def test_inventory_item_is_not_writable(serializer_cls, item):
    assert serializer_cls().fields["inventory_item"].read_only
    serializer = serializer_cls(data={"inventory_item": str(item.pk), "attributes": {}}, partial=True)
    # Valid, so the check below reads real validated_data rather than the {} of a refused body.
    assert serializer.is_valid(), serializer.errors
    assert "inventory_item" not in serializer.validated_data
