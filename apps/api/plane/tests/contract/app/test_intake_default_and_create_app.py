# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A second intake never shadows the default, and POST /intakes/ stays unrouted (APLANE-38).

Two halves of one upstream bug, and the order mattered: repairing the create route without
hardening the lookups is what would have turned a latent trap into a live one.

**The trap.** Nothing enforces one intake per project — the only uniqueness is (name, project) —
and `Intake.Meta.ordering` was `("name",)`. Every project-scoped lookup in both API layers is a
bare `Intake.objects.filter(workspace__slug=…, project_id=…).first()`, nine of them. So an intake
sorting earlier by name would become "the" intake for all of them: new submissions land in the
shadow, and items in the real default 404 on update and destroy.

**And a worse one on the view path, which the ticket did not describe.** `IntakeViewSet.list` is
`get_queryset().first()`, and that queryset annotates a `Count`: Django drops the default ordering
once an aggregate adds a GROUP BY, so the SQL had **no ORDER BY at all** and the row was whatever
the database returned. `Meta.ordering` does not reach it — the view needs its own `order_by`, and
the test for it asserts the SQL, because a behavioural test of an unordered query passes by luck.

**The dead route.** `@allow_permission` sat on `perform_create`, which DRF calls with the
serializer, so the wrapper read `request.user` off a serializer and raised AttributeError into the
base view's catch-all: every POST answered 500 before saving anything.

No path creates a second intake today, which is why the ticket is low — and keeping that true is
why POST is unrouted rather than repaired. These tests are what make it stay true rather than
leaving it as a property nobody checks.
"""

import pytest
from rest_framework import status

from plane.db.models import Intake, Project, ProjectMember, State

pytestmark = pytest.mark.contract

LIST_URL = "/api/workspaces/{slug}/projects/{project_id}/intakes/"


@pytest.fixture
def project(workspace, create_user):
    created = Project.objects.create(name="Intakes", identifier="INT", workspace=workspace)
    ProjectMember.objects.create(workspace=workspace, project=created, member=create_user, role=20)
    State.objects.create(
        name="Triage",
        group="triage",
        color="#60646C",
        sequence=5000,
        project=created,
        workspace=workspace,
    )
    return created


def _intake(project, name, is_default=False):
    return Intake.objects.create(name=name, project=project, workspace=project.workspace, is_default=is_default)


def test_the_meta_ordering_puts_the_default_first(project):
    """Asserted directly because the invariant lives in `Meta.ordering` rather than at the call
    sites: an upstream merge that reverts that one line would reintroduce a silent bug, and this is
    the assertion that makes it loud."""
    assert Intake._meta.ordering == ("-is_default", "name"), (
        "every project-scoped intake lookup is a bare .first() that relies on this ordering"
    )


def test_a_second_intake_never_shadows_the_default(project):
    """`"AAA"` sorts before `"Default"`, so under upstream's `ordering = ("name",)` the bare
    `.first()` every lookup uses would have returned the wrong row."""
    default = _intake(project, "Default", is_default=True)
    _intake(project, "AAA shadow")

    first = Intake.objects.filter(workspace__slug=project.workspace.slug, project_id=project.id).first()

    assert first.id == default.id, "the default must win the lookup whatever else sorts earlier"


def test_the_default_wins_even_when_it_sorts_last(project):
    default = _intake(project, "zzz last by name", is_default=True)
    _intake(project, "aaa")
    _intake(project, "mmm")

    assert Intake.objects.filter(project_id=project.id).first().id == default.id


def test_the_name_order_still_decides_between_non_defaults(project):
    """The second ordering key still does its job — this is not "default first and then random"."""
    _intake(project, "bbb")
    _intake(project, "aaa")

    assert [i.name for i in Intake.objects.filter(project_id=project.id)] == ["aaa", "bbb"]


def test_the_view_queryset_orders_the_default_first(project):
    """The deterministic half, and the reason it exists.

    `list` is `get_queryset().first()`, and that queryset annotates a `Count`. Django drops a
    model's default ordering once an aggregate adds a GROUP BY — measured, the SQL came out with
    **no ORDER BY at all**, so this path was returning whichever row the database felt like, not
    the alphabetically-first one. `Meta.ordering` therefore does NOT fix it; the view needs its own
    `order_by`. Asserted on the SQL because a behavioural test of an unordered query can pass by
    luck — which is exactly what the first version of the test below did, under both the broken and
    the fixed code.
    """
    from plane.app.views.intake.base import IntakeViewSet

    view = IntakeViewSet()
    view.kwargs = {"slug": project.workspace.slug, "project_id": str(project.id)}
    sql = str(view.get_queryset().query).upper()

    assert "ORDER BY" in sql, "the GROUP BY from the Count drops Meta.ordering — this needs its own"
    assert sql.index('"IS_DEFAULT" DESC') < sql.index('"NAME" ASC'), "default first, then by name"


def test_the_list_endpoint_returns_the_default_not_whichever_row_comes_back_first(session_client, workspace, project):
    """The behavioural half. The shadow is created FIRST on purpose: with no ORDER BY, Postgres
    returns rows in physical order, so the broken version hands back the shadow rather than passing
    by luck. The structural assertion above is the one that cannot pass by luck at all."""
    _intake(project, "AAA shadow")
    default = _intake(project, "Default", is_default=True)

    response = session_client.get(LIST_URL.format(slug=workspace.slug, project_id=project.id))

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["id"] == str(default.id)


INBOX_URL = "/api/workspaces/{slug}/projects/{project_id}/inboxes/"


@pytest.mark.parametrize("url", [LIST_URL, INBOX_URL])
def test_posting_an_intake_is_not_routed(session_client, workspace, project, url):
    """The surface decision, pinned (APLANE-38).

    The POST route answered 500 for every caller — `@allow_permission` sat on `perform_create`,
    which DRF calls with the serializer, so the wrapper read `request.user` off it. The ticket
    offered two fixes: repair it, or delete it. Repairing it was measured to be WORSE than the 500,
    for three reasons that have nothing to do with ordering:

    1. `IntakeSerializer` is `fields = "__all__"` with only project and workspace read-only, so a
       member could POST `is_default: true`. Two defaults tie on the ordering's first key, the name
       decides, and `destroy` refuses to delete ANY default — unremovable through the API, because
       `partial_update` is not implemented either.
    2. An intake squatting the name `f"{project.name} Intake"` breaks enabling intake_view:
       `ProjectViewSet` commits `intake_view=True` BEFORE creating the default, then hits the
       (name, project) unique constraint, leaving the project with intake on and no default. 400 on
       every retry, fixable only by deleting the squatter.
    3. `destroy` admits MEMBER and refuses only defaults, so once non-default intakes exist a member
       can publish one on a board, let public submissions accumulate, then delete it and orphan
       them.

    So POST is unrouted and this asserts it stays that way. If it is ever re-routed, fix those three
    first — the viewset's `create` is kept decorated and forces `is_default=False` so that a
    re-route cannot ship an unauthorized create, but that covers only the first of the three.
    """
    response = session_client.post(
        url.format(slug=workspace.slug, project_id=project.id),
        data={"name": "Created through the API"},
        format="json",
    )

    assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED, (
        f"POST must not be routed — repairing it reopens three worse bugs: {response.status_code}"
    )
    assert not Intake.objects.filter(project_id=project.id, name="Created through the API").exists()
