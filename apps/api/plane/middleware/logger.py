# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import hashlib
import hmac
import json
import logging
import re
import time
from urllib.parse import parse_qsl, urlencode

# Django imports
from django.conf import settings
from django.http import HttpRequest

# Third party imports
from rest_framework.request import Request

# Module imports
from plane.utils.ip_address import get_client_ip
from plane.utils.exception_logger import log_exception
from plane.bgtasks.logger_task import process_logs

api_logger = logging.getLogger("plane.api.request")


class RequestLoggerMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _should_log_route(self, request: Request | HttpRequest) -> bool:
        """
        Determines whether a route should be logged based on the request and status code.
        """
        # Don't log health checks
        if request.path == "/" and request.method == "GET":
            return False
        return True

    def __call__(self, request):
        # get the start time
        start_time = time.time()

        # Get the response
        response = self.get_response(request)

        # calculate the duration
        duration = time.time() - start_time

        # Check if logging is required
        log_true = self._should_log_route(request=request)

        # If logging is not required, return the response
        if not log_true:
            return response

        user_id = (
            request.user.id if getattr(request, "user") and getattr(request.user, "is_authenticated", False) else None
        )

        user_agent = request.META.get("HTTP_USER_AGENT", "")

        # Log the request information
        api_logger.info(
            f"{request.method} {request.get_full_path()} {response.status_code}",
            extra={
                "path": request.path,
                "method": request.method,
                "status_code": response.status_code,
                "duration_ms": int(duration * 1000),
                "remote_addr": get_client_ip(request),
                "user_agent": user_agent,
                "user_id": user_id,
            },
        )

        # return the response
        return response


class APITokenLogMiddleware:
    """
    Middleware to log External API requests to PostgreSQL.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_body = request.body
        response = self.get_response(request)
        self.process_request(request, response, request_body)
        return response

    def _safe_decode_body(self, content):
        """
        Safely decodes request/response body content, handling binary data.
        Returns None if content is None, or a string representation of the content.
        """
        # If the content is None, return None
        if content is None:
            return None

        # If the content is an empty bytes object, return None
        if content == b"":
            return None

        # Check if content is binary by looking for common binary file signatures
        if content.startswith(b"\x89PNG") or content.startswith(b"\xff\xd8\xff") or content.startswith(b"%PDF"):
            return "[Binary Content]"

        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return "[Could not decode content]"

    # Headers whose values must never be persisted in plaintext logs
    SENSITIVE_HEADERS = frozenset({"x-api-key", "authorization", "cookie"})

    # Name fragments that mark a value as a credential, matched per word rather than as a
    # substring (APLANE-34). A substring test on "key" would redact `keywords`; splitting on
    # non-alphanumerics gives ["keywords"], which does not match, while `api_key` gives
    # ["api", "key"], which does. Same reason "authorization" is listed but "auth" is not:
    # "author" and "authored_by" are ordinary field names.
    SENSITIVE_PARTS = frozenset(
        {
            "token",
            "tokens",
            "secret",
            "secrets",
            "password",
            "passwd",
            "pwd",
            "key",
            "keys",
            "credential",
            "credentials",
            "authorization",
            "signature",
            "otp",
        }
    )
    # Known, accepted over-redaction: a field like `keyResults` matches on "key". Over-redacting a
    # harmless field costs a little audit detail; under-redacting a secret keeps it for 14 days and
    # in every backup taken in that window. The safe direction is the one chosen.
    REDACTED = "[REDACTED]"
    # What _safe_decode_body returns instead of content it could not use. Compared exactly rather
    # than with a `startswith("[")` test, which the first draft of this used and which would have
    # passed a JSON ARRAY body straight through unredacted.
    DECODE_SENTINELS = frozenset({"[Binary Content]", "[Could not decode content]"})
    _WORDS = re.compile(r"[^a-z0-9]+")
    # camelCase and ACRONYMCase have to be split before lowercasing, or `apiKey` collapses to the
    # single word "apikey" and slips through — which the first version of this did, and JS clients
    # send camelCase as a matter of course (`accessToken`, `clientSecret`, `refreshToken`).
    _CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")

    @classmethod
    def _is_sensitive_name(cls, name) -> bool:
        words = cls._WORDS.split(cls._CAMEL.sub("_", str(name)).lower())
        return any(part in cls.SENSITIVE_PARTS for part in words if part)

    def _redacted_query_string(self, request) -> str:
        """The query string with credential-looking values removed (APLANE-34).

        A client that passes its token as a query parameter rather than a header used to land it
        here in plaintext, for the full retention window and into every backup taken in it — while
        the headers right next to it were carefully redacted, which made that easy to assume could
        not happen.

        Parsed and re-encoded rather than regex-patched, so a value containing `&` or `=` cannot
        hide a second parameter from the redactor. An unparseable query string is replaced wholesale
        rather than stored: it is not worth guessing at.
        """
        raw = request.META.get("QUERY_STRING", "")
        if not raw:
            return ""
        try:
            pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=False)
            return urlencode([(key, self.REDACTED if self._is_sensitive_name(key) else value) for key, value in pairs])
        except Exception:
            return "[UNPARSEABLE QUERY STRING]"

    def _redacted_body(self, request_body):
        """The request body with credential-looking values removed (APLANE-34).

        JSON objects and arrays are walked and redacted by key name, at any depth, because that is
        what this API receives — arrays matter because the bulk endpoints post lists of objects. Anything else — form encoding, XML, a raw upload — cannot be
        redacted by key, so it is dropped rather than stored in the clear: an unreadable audit field
        is a smaller loss than a secret kept for 14 days. JSON that is not an object (a bare string
        or number) is dropped for the same reason.
        """
        if not request_body:
            return None
        decoded = self._safe_decode_body(request_body)
        if decoded is None or decoded in self.DECODE_SENTINELS:
            return decoded
        try:
            parsed = json.loads(decoded)
        except (ValueError, TypeError):
            return "[NOT JSON — DROPPED, MAY CONTAIN SECRETS]"
        if not isinstance(parsed, (dict, list)):
            return "[NON-OBJECT JSON — DROPPED, MAY CONTAIN SECRETS]"
        return json.dumps(self._redact_tree(parsed))

    def _redact_tree(self, value):
        if isinstance(value, dict):
            return {
                key: (self.REDACTED if self._is_sensitive_name(key) else self._redact_tree(item))
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._redact_tree(item) for item in value]
        return value

    # Cap on a stored failure body, in BYTES — the column is TEXT and the cost is bytes, not code
    # points. 8192 *characters* was the first version of this and it bounded almost nothing: 8192
    # multi-byte characters is up to 32 KB, so if plane-bot ever starts getting a persistent 4xx
    # (expired token, renamed project, a 429 storm) its ~4,500 requests/day would rebuild the very
    # problem this change exists to fix, in the same column. 2000 bytes keeps the worst case around
    # 126 MB/14 days instead of ~2 GB, and the external API's real error bodies are tens of bytes
    # (`{"error": "The payload is not valid"}`), so nothing diagnostic is lost.
    RESPONSE_BODY_MAX_BYTES = 2000

    def _response_body_to_log(self, response):
        """The response body to persist: failures only, capped (APLANE-18).

        Storing every successful response made prod's `api_activity_logs` 901 MB of a 947 MB
        database — 95%, 718 MB of it TOASTed work-item list payloads, because plane-bot's mirror
        polls the v1 API every 60 s and this middleware kept each full response. A 2xx body is
        something the caller already received and nothing reads it back: nothing in the fork or in
        the test suite selects `api_activity_logs.response_body`. A failure's body is the one case
        where this row is the only copy, so that is what is kept.

        The status check comes first on purpose, so a successful streaming response is never
        touched here at all (`.content` does not exist on one, and reaching for it only ever
        raised into the caller's except).
        """
        if 200 <= response.status_code < 300:
            return None
        content = getattr(response, "content", None)
        if not content:
            return None
        body = self._safe_decode_body(content)
        if body is None:
            return None
        encoded = body.encode("utf-8")
        if len(encoded) <= self.RESPONSE_BODY_MAX_BYTES:
            return body
        # errors="ignore" drops a code point the byte cut landed inside, so the stored value is
        # always valid UTF-8. It is not valid JSON any more, which nothing cares about: no code in
        # the fork and nothing in the test suite reads this column, and the marker makes the
        # truncation self-evident to a human reading the row.
        head = encoded[: self.RESPONSE_BODY_MAX_BYTES].decode("utf-8", errors="ignore")
        return f"{head}… [truncated]"

    def _redacted_headers(self, request):
        """
        Returns the request headers as a string with sensitive values redacted,
        so that credentials such as the API key are never stored in plaintext.
        """
        redacted = {
            key: ("[REDACTED]" if key.lower() in self.SENSITIVE_HEADERS else value)
            for key, value in request.headers.items()
        }
        return str(redacted)

    def process_request(self, request, response, request_body):
        api_key_header = "X-Api-Key"
        api_key = request.headers.get(api_key_header)

        # If the API key is not present, return
        if not api_key:
            return

        try:
            log_data = {
                # Tokenize the (high-entropy) API key into a stable, non-reversible
                # identifier so logs can be correlated to a token without ever
                # persisting the raw key. A keyed HMAC is used rather than a bare
                # hash so the digest cannot be precomputed from a known key value.
                "token_identifier": hmac.new(
                    settings.SECRET_KEY.encode(), api_key.encode(), hashlib.sha256
                ).hexdigest(),
                "path": request.path,
                "method": request.method,
                "query_params": self._redacted_query_string(request),
                "headers": self._redacted_headers(request),
                "body": self._redacted_body(request_body),
                "response_body": self._response_body_to_log(response),
                "response_code": response.status_code,
                "ip_address": get_client_ip(request=request),
                "user_agent": request.META.get("HTTP_USER_AGENT", None),
            }

            process_logs.delay(log_data=log_data)

        except Exception as e:
            log_exception(e)

        return None
