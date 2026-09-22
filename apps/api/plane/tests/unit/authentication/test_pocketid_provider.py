# L2 (APLANE-15): the "gitea" OAuth slot is really Pocket ID (OIDC).
#
# Was a bind-mounted file over the container's gitea.py; now it is source, so the endpoints
# and claim mapping it depends on are pinned here. Pocket ID is a real login path for every
# user, so a silent revert to Gitea's URLs would lock the workspace out.

from unittest.mock import patch

import pytest

from plane.authentication.provider.oauth.gitea import GiteaOAuthProvider

HOST = "https://auth.example.invalid"


@pytest.fixture
def provider(rf):
    request = rf.get("/auth/gitea/")
    request.session = {}
    with patch(
        "plane.authentication.provider.oauth.gitea.get_configuration_value",
        return_value=("client-id", "client-secret", HOST),
    ):
        yield GiteaOAuthProvider(request=request, state="state-1")


@pytest.mark.unit
class TestPocketIdProvider:
    def test_oidc_endpoints_not_gitea_ones(self, provider):
        assert provider.token_url == f"{HOST}/api/oidc/token"
        assert provider.userinfo_url == f"{HOST}/api/oidc/userinfo"
        assert "/login/oauth/" not in provider.auth_url
        assert provider.auth_url.startswith(f"{HOST}/authorize?")

    def test_scope_is_plain_oidc(self, provider):
        # read:user is a Gitea scope; Pocket ID rejects an unknown scope outright
        assert provider.scope == "openid email profile"

    def test_userinfo_claims_map_to_a_plane_user(self, provider):
        claims = {
            "sub": "pocket-id-123",
            "email": "someone@example.invalid",
            "given_name": "Someone",
            "family_name": "Else",
            "picture": "https://example.invalid/avatar.png",
        }
        with patch.object(GiteaOAuthProvider, "get_user_response", return_value=claims):
            provider.set_user_data()
        data = provider.user_data
        assert data["email"] == "someone@example.invalid"
        assert data["user"]["provider_id"] == "pocket-id-123"
        assert data["user"]["first_name"] == "Someone"
        assert data["user"]["last_name"] == "Else"
        assert data["user"]["avatar"] == "https://example.invalid/avatar.png"
        # Pocket ID owns the credentials: a Plane password must never be expected
        assert data["user"]["is_password_autoset"] is True

    def test_a_name_only_provider_still_yields_a_first_name(self, provider):
        # Pocket ID sends given_name; other OIDC providers only send name
        with patch.object(
            GiteaOAuthProvider,
            "get_user_response",
            return_value={"sub": "x", "email": "n@example.invalid", "name": "Only Name"},
        ):
            provider.set_user_data()
        assert provider.user_data["user"]["first_name"] == "Only Name"
        assert provider.user_data["user"]["last_name"] == ""
