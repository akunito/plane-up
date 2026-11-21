# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

from plane.app.views.inventory import (
    InventoryCategoryRenameEndpoint,
    InventoryListsEndpoint,
    InventoryOpsEndpoint,
    InventoryPreferenceEndpoint,
    InventoryShoppingListEndpoint,
    InventorySuggestionsEndpoint,
    ProjectInventoryItemDetailEndpoint,
    ProjectInventoryItemHistoryEndpoint,
    ProjectInventoryItemPhotoEndpoint,
    ProjectInventoryItemsEndpoint,
    ProjectInventoryListDetailEndpoint,
    ProjectInventoryListsEndpoint,
)

urlpatterns = [
    path(
        "workspaces/<str:slug>/inventory/shopping-list/",
        InventoryShoppingListEndpoint.as_view(),
        name="inventory-shopping-list",
    ),
    path("workspaces/<str:slug>/inventory/lists/", InventoryListsEndpoint.as_view(), name="inventory-lists"),
    path("workspaces/<str:slug>/inventory/ops/", InventoryOpsEndpoint.as_view(), name="inventory-ops"),
    path(
        "workspaces/<str:slug>/inventory/categories/rename/",
        InventoryCategoryRenameEndpoint.as_view(),
        name="inventory-category-rename",
    ),
    path(
        "workspaces/<str:slug>/inventory/suggestions/",
        InventorySuggestionsEndpoint.as_view(),
        name="inventory-suggestions",
    ),
    path(
        "workspaces/<str:slug>/inventory/preferences/",
        InventoryPreferenceEndpoint.as_view(),
        name="inventory-preferences",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/lists/",
        ProjectInventoryListsEndpoint.as_view(),
        name="project-inventory-lists",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/lists/<uuid:pk>/",
        ProjectInventoryListDetailEndpoint.as_view(),
        name="project-inventory-list-detail",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/lists/<uuid:list_id>/items/",
        ProjectInventoryItemsEndpoint.as_view(),
        name="project-inventory-items",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/items/<uuid:pk>/",
        ProjectInventoryItemDetailEndpoint.as_view(),
        name="project-inventory-item-detail",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/items/<uuid:pk>/history/",
        ProjectInventoryItemHistoryEndpoint.as_view(),
        name="project-inventory-item-history",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/items/<uuid:pk>/photo/",
        ProjectInventoryItemPhotoEndpoint.as_view(),
        name="project-inventory-item-photo",
    ),
    path(
        "workspaces/<str:slug>/projects/<uuid:project_id>/inventory/items/<uuid:pk>/photo/<uuid:asset_id>/",
        ProjectInventoryItemPhotoEndpoint.as_view(),
        name="project-inventory-item-photo-asset",
    ),
]
