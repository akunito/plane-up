# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
from uuid import uuid4

# Django import
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

# Module import
from plane.utils.path_validator import sanitize_filename

from .base import BaseModel
from .project import ProjectMember


def get_upload_path(instance, filename):
    filename = sanitize_filename(filename) or uuid4().hex
    if instance.workspace_id is not None:
        return f"{instance.workspace.id}/{uuid4().hex}-{filename}"
    return f"user-{uuid4().hex}-{filename}"


def file_size(value):
    if value.size > settings.FILE_SIZE_LIMIT:
        raise ValidationError("File too large. Size should not exceed 5 MB.")


class FileAsset(BaseModel):
    """
    A file asset.
    """

    class EntityTypeContext(models.TextChoices):
        ISSUE_ATTACHMENT = "ISSUE_ATTACHMENT"
        ISSUE_DESCRIPTION = "ISSUE_DESCRIPTION"
        COMMENT_DESCRIPTION = "COMMENT_DESCRIPTION"
        PAGE_DESCRIPTION = "PAGE_DESCRIPTION"
        USER_COVER = "USER_COVER"
        USER_AVATAR = "USER_AVATAR"
        WORKSPACE_LOGO = "WORKSPACE_LOGO"
        PROJECT_COVER = "PROJECT_COVER"
        DRAFT_ISSUE_ATTACHMENT = "DRAFT_ISSUE_ATTACHMENT"
        DRAFT_ISSUE_DESCRIPTION = "DRAFT_ISSUE_DESCRIPTION"

    # An inventory item's photo (APLANE-66). Deliberately NOT in EntityTypeContext: the generic upload and
    # duplicate views accept any value of it, and photos are created only by the inventory photo endpoint.
    INVENTORY_ITEM_PHOTO = "INVENTORY_ITEM_PHOTO"

    attributes = models.JSONField(default=dict)
    asset = models.FileField(upload_to=get_upload_path, max_length=800)
    user = models.ForeignKey("db.User", on_delete=models.CASCADE, null=True, related_name="assets")
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, null=True, related_name="assets")
    draft_issue = models.ForeignKey("db.DraftIssue", on_delete=models.CASCADE, null=True, related_name="assets")
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE, null=True, related_name="assets")
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, null=True, related_name="assets")
    comment = models.ForeignKey("db.IssueComment", on_delete=models.CASCADE, null=True, related_name="assets")
    page = models.ForeignKey("db.Page", on_delete=models.CASCADE, null=True, related_name="assets")
    # An inventory item's photo (APLANE-66). CASCADE so the item's soft delete reaches the photo; its row and
    # stored object go INVENTORY_PHOTO_PURGE_DAYS later (purge_removed_inventory_photos), or with the general
    # purge when armed (HARD_DELETE_ENABLED, _doomed_blobs), whichever runs first.
    # Nullable: a rollback to an image without the column must still insert assets (brief, M7).
    inventory_item = models.ForeignKey("db.InventoryItem", on_delete=models.CASCADE, null=True, related_name="assets")
    entity_type = models.CharField(max_length=255, null=True, blank=True)
    entity_identifier = models.CharField(max_length=255, null=True, blank=True)
    is_deleted = models.BooleanField(default=False)
    is_archived = models.BooleanField(default=False)
    external_id = models.CharField(max_length=255, null=True, blank=True)
    external_source = models.CharField(max_length=255, null=True, blank=True)
    size = models.FloatField(default=0)
    is_uploaded = models.BooleanField(default=False)
    storage_metadata = models.JSONField(default=dict, null=True, blank=True)

    class Meta:
        verbose_name = "File Asset"
        verbose_name_plural = "File Assets"
        db_table = "file_assets"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["entity_type"], name="asset_entity_type_idx"),
            models.Index(fields=["entity_identifier"], name="asset_entity_identifier_idx"),
            models.Index(fields=["entity_type", "entity_identifier"], name="asset_entity_idx"),
            models.Index(fields=["asset"], name="asset_asset_idx"),
        ]

    def __str__(self):
        return str(self.asset)

    @property
    def asset_url(self):
        if (
            self.entity_type == self.EntityTypeContext.WORKSPACE_LOGO
            or self.entity_type == self.EntityTypeContext.USER_AVATAR
            or self.entity_type == self.EntityTypeContext.USER_COVER
            or self.entity_type == self.EntityTypeContext.PROJECT_COVER
        ):
            return f"/api/assets/v2/static/{self.id}/"

        if self.entity_type == self.EntityTypeContext.ISSUE_ATTACHMENT:
            return f"/api/assets/v2/workspaces/{self.workspace.slug}/projects/{self.project_id}/issues/{self.issue_id}/attachments/{self.id}/"  # noqa: E501

        if self.entity_type in [
            self.EntityTypeContext.ISSUE_DESCRIPTION,
            self.EntityTypeContext.COMMENT_DESCRIPTION,
            self.EntityTypeContext.PAGE_DESCRIPTION,
            self.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ]:
            return f"/api/assets/v2/workspaces/{self.workspace.slug}/projects/{self.project_id}/{self.id}/"

        return None

    @property
    def is_inventory_photo(self):
        return self.inventory_item_id is not None or self.entity_type == self.INVENTORY_ITEM_PHOTO

    def is_project_accessible_to(self, user):
        """Return whether ``user`` is an active member of this asset's project.

        Covers the project dimension only; callers still check workspace access
        (the endpoint's permission class or ``allow_permission(..., level="WORKSPACE")``).
        Lives on the model so the app and external-API asset views share one rule.

        Assets with no project (workspace logos, user avatars and covers) are
        workspace-level, so this returns True for them.

        An inventory photo is False for everyone: inventory is for project members only (guests excluded),
        which this project-membership rule cannot express, so photos are served only by the inventory photo
        endpoints and every generic asset view that asks here refuses them (APLANE-66).
        """
        if self.is_inventory_photo:
            return False
        if self.project_id is None:
            return True
        # Scope the membership to the asset's workspace as well as its project.
        return ProjectMember.objects.filter(
            member=user,
            workspace_id=self.workspace_id,
            project_id=self.project_id,
            is_active=True,
        ).exists()
