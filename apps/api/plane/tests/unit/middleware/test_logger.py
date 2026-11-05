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
import json
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


@pytest.mark.unit
class TestRequestBodyAndQueryAreRedacted:
    """APLANE-34: the logger redacted headers carefully and stored the body and query string raw.

    A client that passes its token as a query parameter — or posts anything secret — used to land it
    in `api_activity_logs` in plaintext for the full 14-day retention and into every backup taken
    in that window, right next to headers that were being redacted with care.
    """

    API_KEY = "plane_api_supersecretvalue"

    def _log_data(self, request_factory, path="/api/v1/workspaces/", body=None, **extra):
        middleware = APITokenLogMiddleware(Mock(return_value=HttpResponse(b"{}")))
        request = request_factory.get(path, HTTP_X_API_KEY=self.API_KEY, **extra)
        request.user = AnonymousUser()
        with patch("plane.middleware.logger.process_logs") as process_logs:
            middleware.process_request(request, HttpResponse(b"{}"), request_body=body)
            assert process_logs.delay.called
            return process_logs.delay.call_args.kwargs["log_data"]

    # --- the one that matters most: the key must not survive anywhere in the row ---

    def test_a_key_passed_in_the_query_string_appears_in_no_field(self, request_factory):
        log_data = self._log_data(request_factory, path=f"/api/v1/x/?key={self.API_KEY}&page=2")

        assert self.API_KEY not in json.dumps(log_data), "the API key survived somewhere in the row"
        assert "page=2" in log_data["query_params"], "and the harmless parameters are still there"

    def test_a_secret_posted_in_the_body_appears_in_no_field(self, request_factory):
        body = json.dumps({"name": "hook", "webhook_secret": self.API_KEY}).encode()

        log_data = self._log_data(request_factory, body=body)

        assert self.API_KEY not in json.dumps(log_data)
        assert "hook" in log_data["body"], "and the rest of the body is still logged"

    # --- query string ---

    @pytest.mark.parametrize("name", ["key", "api_key", "apiKey", "token", "access_token", "password", "signature"])
    def test_sensitive_query_values_are_redacted(self, request_factory, name):
        log_data = self._log_data(request_factory, path=f"/api/v1/x/?{name}=leak&cursor=abc")

        assert "leak" not in log_data["query_params"]
        assert "cursor=abc" in log_data["query_params"]

    def test_a_value_containing_an_ampersand_cannot_hide_a_parameter(self, request_factory):
        """Parsed and re-encoded rather than regex-patched, so an encoded `&token=` inside another
        value is a value, not a parameter the redactor might miss."""
        log_data = self._log_data(request_factory, path="/api/v1/x/?key=leak&name=hello%26token%3Dnope")

        assert "leak" not in log_data["query_params"]
        assert "hello" in log_data["query_params"]

    def test_an_empty_query_string_stays_empty(self, request_factory):
        assert self._log_data(request_factory)["query_params"] == ""

    # --- body ---

    def test_nested_and_listed_secrets_are_redacted(self, request_factory):
        body = json.dumps(
            {"name": "x", "meta": {"api_key": "leak1", "keywords": ["fine"]}, "items": [{"token": "leak2", "id": 1}]}
        ).encode()

        stored = self._log_data(request_factory, body=body)["body"]

        assert "leak1" not in stored and "leak2" not in stored
        assert "fine" in stored and '"id": 1' in stored

    def test_a_json_array_body_is_redacted_not_passed_through(self, request_factory):
        """A JSON array starts with "[", which an earlier draft used to detect the decode
        sentinels — so an array body would have been stored verbatim."""
        body = json.dumps([{"token": "leak", "id": 1}]).encode()

        stored = self._log_data(request_factory, body=body)["body"]

        assert "leak" not in stored
        assert '"id": 1' in stored

    def test_a_non_json_body_is_dropped_rather_than_stored(self, request_factory):
        stored = self._log_data(request_factory, body=b"password=leak&grant_type=x")["body"]

        assert "leak" not in stored
        assert "DROPPED" in stored, "and it says why, so the gap is visible in the row"

    def test_a_bare_json_scalar_is_dropped(self, request_factory):
        assert "DROPPED" in self._log_data(request_factory, body=b'"just a string"')["body"]

    def test_an_empty_body_is_none(self, request_factory):
        assert self._log_data(request_factory, body=b"")["body"] is None

    def test_binary_content_keeps_its_sentinel(self, request_factory):
        assert self._log_data(request_factory, body=b"\x89PNG\r\n")["body"] == "[Binary Content]"

    # --- the names themselves ---

    @pytest.mark.parametrize(
        "name", ["keywords", "author", "authoredBy", "monkey", "sequenceId", "assignee_ids", "description_html"]
    )
    def test_ordinary_field_names_are_not_redacted(self, request_factory, name):
        """A substring test on "key" would redact `keywords`; matching per word does not."""
        body = json.dumps({name: "kept"}).encode()

        assert "kept" in self._log_data(request_factory, body=body)["body"]

    @pytest.mark.parametrize("name", ["apiKey", "accessToken", "clientSecret", "refreshToken", "OTPCode"])
    def test_camel_case_credentials_are_redacted(self, request_factory, name):
        """camelCase has to be split before lowercasing or `apiKey` collapses to one word and slips
        through — which the first version did, and JS clients send camelCase as a matter of course."""
        body = json.dumps({name: "leak"}).encode()

        assert "leak" not in self._log_data(request_factory, body=body)["body"]
