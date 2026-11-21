# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from .base import BaseSerializer
from plane.db.models import FileAsset


class FileAssetSerializer(BaseSerializer):
    class Meta:
        model = FileAsset
        fields = "__all__"
        # inventory_item is meant to be set only by the inventory photo endpoints (APLANE-66). Every FileAsset
        # serializer is "__all__" and three views save one straight from the request body (v1 uploads here,
        # issue attachments), and DRF resolves the key against all items: writable, any member could hang a
        # file on an item of any project. Read-only on all five, pinned by test_file_asset_inventory_item_read_only.
        read_only_fields = ["created_by", "updated_by", "created_at", "updated_at", "inventory_item"]
