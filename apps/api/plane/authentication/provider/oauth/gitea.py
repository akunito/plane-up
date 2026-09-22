# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.
#
# The built-in "gitea" OAuth slot is
# repurposed as a generic Pocket ID (auth.akunito.com) OIDC login. Gitea's
# adapter already uses OIDC scopes + a configurable host and a confidential
# (client_secret) code exchange with no PKCE, so only the endpoint paths and
# the userinfo claim parsing differ. GITEA_HOST/CLIENT_ID/CLIENT_SECRET env
# vars carry the Pocket ID values; the /auth/gitea/ routes are reused as-is.
#
# Was a bind-mounted file over the container's gitea.py until APLANE-15 built our own image.
# The slot name stays "gitea" on purpose: the routes, the instance configuration rows and the
# existing users' provider_id all key off it, so renaming it would log everyone out.

import os
from datetime import datetime, timedelta
from urllib.parse import urlencode, urlparse

import pytz

from plane.authentication.adapter.oauth import OauthAdapter
from plane.license.utils.instance_value import get_configuration_value
from plane.authentication.adapter.error import (
    AUTHENTICATION_ERROR_CODES,
    AuthenticationException,
)


class GiteaOAuthProvider(OauthAdapter):
    provider = "gitea"
    scope = "openid email profile"

    def __init__(self, request, code=None, state=None, callback=None):
        (GITEA_CLIENT_ID, GITEA_CLIENT_SECRET, GITEA_HOST) = get_configuration_value(
            [
                {
                    "key": "GITEA_CLIENT_ID",
                    "default": os.environ.get("GITEA_CLIENT_ID"),
                },
                {
                    "key": "GITEA_CLIENT_SECRET",
                    "default": os.environ.get("GITEA_CLIENT_SECRET"),
                },
                {
                    "key": "GITEA_HOST",
                    "default": os.environ.get("GITEA_HOST"),
                },
            ]
        )

        if not (GITEA_CLIENT_ID and GITEA_CLIENT_SECRET and GITEA_HOST):
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["GITEA_NOT_CONFIGURED"],
                error_message="GITEA_NOT_CONFIGURED",
            )

        # Enforce scheme and normalize trailing slash(es)
        parsed = urlparse(GITEA_HOST)
        if not parsed.scheme or parsed.scheme not in ("https", "http"):
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["GITEA_NOT_CONFIGURED"],
                error_message="GITEA_NOT_CONFIGURED",
            )
        GITEA_HOST = GITEA_HOST.rstrip("/")

        # Pocket ID / standard OIDC discovery endpoints
        self.token_url = f"{GITEA_HOST}/api/oidc/token"
        self.userinfo_url = f"{GITEA_HOST}/api/oidc/userinfo"

        client_id = GITEA_CLIENT_ID
        client_secret = GITEA_CLIENT_SECRET

        redirect_uri = f"{'https' if request.is_secure() else 'http'}://{request.get_host()}/auth/gitea/callback/"
        url_params = {
            "client_id": client_id,
            "scope": self.scope,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "state": state,
        }
        auth_url = f"{GITEA_HOST}/authorize?{urlencode(url_params)}"

        super().__init__(
            request,
            self.provider,
            client_id,
            self.scope,
            redirect_uri,
            auth_url,
            self.token_url,
            self.userinfo_url,
            client_secret,
            code,
            callback=callback,
        )

    def set_token_data(self):
        data = {
            "code": self.code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code",
        }
        headers = {"Accept": "application/json"}
        token_response = self.get_user_token(data=data, headers=headers)
        super().set_token_data(
            {
                "access_token": token_response.get("access_token"),
                "refresh_token": token_response.get("refresh_token", None),
                "access_token_expired_at": (
                    datetime.now(tz=pytz.utc) + timedelta(seconds=token_response.get("expires_in"))
                    if token_response.get("expires_in")
                    else None
                ),
                "refresh_token_expired_at": None,
                "id_token": token_response.get("id_token", ""),
            }
        )

    def set_user_data(self):
        user_info_response = self.get_user_response()
        email = user_info_response.get("email")
        super().set_user_data(
            {
                "email": email,
                "user": {
                    "provider_id": str(user_info_response.get("sub")),
                    "email": email,
                    "avatar": user_info_response.get("picture"),
                    "first_name": (
                        user_info_response.get("given_name")
                        or user_info_response.get("name")
                        or ""
                    ),
                    "last_name": user_info_response.get("family_name") or "",
                    "is_password_autoset": True,
                },
            }
        )
