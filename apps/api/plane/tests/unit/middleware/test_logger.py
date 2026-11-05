# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Unit tests for APITokenLogMiddleware.

Covers the credential-hygiene guarantees of the external API request logger:
- the raw API key is never persisted (a non-reversible hash is stored instead)
- sensitive request headers are redacted before being logged
- and what it stores of the response body (APLANE-18): failures only, capped
"""

import hashlib
import hmac
from unittest.mock import Mock, patch

import pytest
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory

from plane.middleware.logger import APITokenLogMiddleware


@pytest.fixture
def request_factory():
    return RequestFactory()


@pytest.fixture
def middleware():
    return APITokenLogMiddleware(Mock(return_value=HttpResponse(b"{}")))


@pytest.mark.unit
class TestAPITokenLogMiddleware:
    API_KEY = "plane_api_supersecretvalue"
    AUTHORIZATION = "Bearer secret-bearer-token"
    COOKIE = "sessionid=secret-session-value"

    def _captured_log_data(self, middleware, request_factory, response=None):
        request = request_factory.get(
            "/api/v1/workspaces/",
            HTTP_X_API_KEY=self.API_KEY,
            HTTP_AUTHORIZATION=self.AUTHORIZATION,
            HTTP_COOKIE=self.COOKIE,
        )
        request.user = AnonymousUser()
        response = HttpResponse(b"{}") if response is None else response
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, response, request_body=b"")
            assert process_logs.delay.called
            return process_logs.delay.call_args.kwargs["log_data"]

    def test_token_identifier_is_hashed_not_plaintext(self, middleware, request_factory):
        log_data = self._captured_log_data(middleware, request_factory)

        expected_hash = hmac.new(
            settings.SECRET_KEY.encode(), self.API_KEY.encode(), hashlib.sha256
        ).hexdigest()
        assert log_data["token_identifier"] == expected_hash
        assert self.API_KEY not in log_data["token_identifier"]

    def test_sensitive_headers_are_redacted(self, middleware, request_factory):
        log_data = self._captured_log_data(middleware, request_factory)

        # None of the sensitive header values may appear in the logged headers.
        assert self.API_KEY not in log_data["headers"]
        assert self.AUTHORIZATION not in log_data["headers"]
        assert self.COOKIE not in log_data["headers"]
        assert "[REDACTED]" in log_data["headers"]

    def test_no_log_without_api_key(self, middleware, request_factory):
        request = request_factory.get("/api/v1/workspaces/")
        request.user = AnonymousUser()
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, HttpResponse(b"{}"), request_body=b"")
            assert not process_logs.delay.called


@pytest.mark.unit
class TestResponseBodyIsOnlyKeptForFailures:
    """APLANE-18: successful response bodies are not persisted.

    Storing them made prod's api_activity_logs 901 MB of a 947 MB database — 95%, because
    plane-bot's mirror polls the v1 API every 60 s and each full work-item list response was kept.
    Nothing reads the column back, so a 2xx body buys nothing; a failure's body is the one case
    where the log row is the only copy.
    """

    API_KEY = "plane_api_supersecretvalue"

    def _log_data(self, request_factory, response):
        middleware = APITokenLogMiddleware(Mock(return_value=response))
        request = request_factory.get("/api/v1/workspaces/", HTTP_X_API_KEY=self.API_KEY)
        request.user = AnonymousUser()
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, response, request_body=b"")
            assert process_logs.delay.called, "the request must still be logged"
            return process_logs.delay.call_args.kwargs["log_data"]

    @pytest.mark.parametrize("status", [200, 201, 204, 299])
    def test_successful_bodies_are_not_stored(self, request_factory, status):
        payload = b'{"results": ["a very large work item list"]}'
        log_data = self._log_data(request_factory, HttpResponse(payload, status=status))

        assert log_data["response_body"] is None
        # the row itself must survive — this is a storage change, not a logging change
        assert log_data["response_code"] == status
        assert log_data["path"] == "/api/v1/workspaces/"

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500, 503])
    def test_failure_bodies_are_stored(self, request_factory, status):
        log_data = self._log_data(request_factory, HttpResponse(b'{"error": "boom"}', status=status))

        assert log_data["response_body"] == '{"error": "boom"}'

    def test_a_redirect_is_kept_too(self, request_factory):
        """3xx is not success; whatever it carries is cheap and may explain a misrouted client."""
        log_data = self._log_data(request_factory, HttpResponse(b"moved", status=302))

        assert log_data["response_body"] == "moved"

    def test_a_large_failure_body_is_truncated(self, request_factory):
        cap = APITokenLogMiddleware.RESPONSE_BODY_MAX_BYTES
        log_data = self._log_data(request_factory, HttpResponse(b"x" * (cap + 5000), status=400))

        body = log_data["response_body"]
        assert body.endswith("… [truncated]")
        assert len(body.encode()) == cap + len("… [truncated]".encode())

    def test_a_failure_body_at_the_cap_is_not_truncated(self, request_factory):
        exact = b"x" * APITokenLogMiddleware.RESPONSE_BODY_MAX_BYTES
        log_data = self._log_data(request_factory, HttpResponse(exact, status=400))

        assert log_data["response_body"] == exact.decode()

    def test_the_cap_is_bytes_not_characters(self, request_factory):
        """The whole point of the cap: 2000 multi-byte characters would be up to 8000 bytes.

        The first version of this counted code points, which bounded almost nothing — a persistent
        4xx against plane-bot's ~4,500 requests/day would have rebuilt the problem in the same
        column.
        """
        cap = APITokenLogMiddleware.RESPONSE_BODY_MAX_BYTES
        # "é" is 2 bytes, so `cap` of them is twice the budget
        log_data = self._log_data(request_factory, HttpResponse("é".encode() * cap, status=400))

        stored = log_data["response_body"]
        assert stored.endswith("… [truncated]")
        assert len(stored.encode()) <= cap + len("… [truncated]".encode())
        assert len(stored) < cap, "a character count would have let twice the bytes through"

    def test_truncation_never_leaves_invalid_utf8(self, request_factory):
        """A byte cut can land inside a code point; the stored value must still be valid UTF-8."""
        cap = APITokenLogMiddleware.RESPONSE_BODY_MAX_BYTES
        # 3-byte characters, so the cut at `cap` bytes falls mid-character for most caps
        payload = ("€" * ((cap // 3) + 50)).encode()
        log_data = self._log_data(request_factory, HttpResponse(payload, status=500))

        stored = log_data["response_body"]
        stored.encode("utf-8").decode("utf-8")  # raises if the cut corrupted it
        assert "\ufffd" not in stored, "no replacement characters — the split tail is dropped, not mangled"

    def test_an_empty_failure_body_is_none(self, request_factory):
        log_data = self._log_data(request_factory, HttpResponse(b"", status=404))

        assert log_data["response_body"] is None

    def test_a_streaming_success_is_never_touched(self, request_factory):
        """The status check comes first so `.content` is not reached on a 2xx.

        A StreamingHttpResponse has no `.content`; the old code reached for it and raised into
        process_request's except, which silently dropped the whole log row.
        """
        response = StreamingHttpResponse((b"chunk" for _ in range(3)), status=200)

        log_data = self._log_data(request_factory, response)

        assert log_data["response_body"] is None
        assert log_data["response_code"] == 200, "and the row is still logged, which it was not before"
