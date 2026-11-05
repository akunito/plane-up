# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import hashlib
import hmac
import ipaddress
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
    SENSITIVE_HEADERS = frozenset(
        {"x-api-key", "authorization", "cookie", "authentication", "x-csrftoken", "x-csrf-token"}
    )

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
            # Plane's own one-time credential: read from a JSON body in the email-change flow
            # (app/views/user/base.py:199, "Verify the magic code") and sent BY the provider as
            # `?code=` to all EIGHT OAuth callbacks (app and space x google/github/gitlab/gitea).
            # Defence in depth rather than a live leak: none of those requests carries an
            # X-Api-Key, so this middleware never logs them today. Free to add — no serializer in
            # plane/api has a `code` field, and the only `*code*` model field in the fork is
            # APIActivityLog.response_code, which no serializer exposes.
            "code",
            "codes",
            # Concatenated and acronym spellings the word split alone cannot reach.
            "apikey",
            "accesstoken",
            "authtoken",
            "sessionid",
            "passphrase",
            "totp",
            "jwt",
            "bearer",
            "salt",
            "nonce",
            "hmac",
            "sig",
        }
    )
    # Known, accepted over-redaction, with the real example rather than a guess: EstimatePoint.key
    # (db/models/estimate.py:45) is an integer the external API writes through `fields = "__all__"`,
    # so estimate-point writes now log `"key": "[REDACTED]"` instead of the point number. Over-
    # redacting a harmless field costs a little audit detail; under-redacting a secret keeps it for
    # the 14-day retention, the daily dump and the offsite copy — the HOURLY dumps already exclude
    # this table (VPS_PROD-config.nix), so "every backup" overstated it. Safe direction chosen.
    REDACTED = "[REDACTED]"
    # Deliberately DOUBLE RESPONSE_BODY_MAX_BYTES, not a mirror of it: a request body is the half
    # of an audit trail you actually want to read later, while a response body is mostly something
    # the caller already had. The cost is the tail of any description_html write over 4 KB, which
    # is common. Capped at all because Django accepts a 5 MB body (DATA_UPLOAD_MAX_MEMORY_SIZE) and
    # a row is written for any request merely BEARING an X-Api-Key, valid or not — so uncapped, an
    # unauthenticated caller could write 5 MB rows.
    BODY_MAX_BYTES = 4000
    # Deeper than anything this API accepts; see _redact_tree for why the bound exists at all.
    MAX_DEPTH = 32
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
        hide a second parameter from the redactor. The limit of that, measured: `parse_qsl` splits
        only on `&`, so `?a=1;token=SECRET` is ONE parameter whose value holds the secret in
        plaintext. Harmless in practice — Django's own parsing does not split on `;` either, so a
        client doing that would be leaking its secret for nothing rather than authenticating.

        The except branch is unreachable through a real request, but it is NOT unreachable: a lone
        surrogate in QUERY_STRING makes `urlencode` raise UnicodeEncodeError. WSGI decodes the
        request line as latin-1 and Django's ASGI path decodes strictly, so no client can put one
        there — the branch stays. This correction is here because an earlier version of this
        docstring claimed "neither call raises on any input I could construct", and the identical
        blind spot about `encode` raising is what let a 14-byte body suppress the audit row in
        _redacted_body below. An invalid percent escape, by contrast, really does come back
        mangled to U+FFFD rather than raising.
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

        JSON objects and arrays are walked and redacted by key name, down to MAX_DEPTH — arrays
        matter because the bulk endpoints post lists of objects. Anything else (form encoding,
        XML, a raw upload) cannot be redacted by key, so it is dropped with a marker rather than
        stored in the clear: an unreadable audit field is a smaller loss than a secret kept for
        the retention window. JSON that is not an object or array is dropped for the same reason.

        `ensure_ascii=False` and compact separators are deliberate. The default re-encodes every
        non-ASCII code point as a six-character backslash-u escape, in the exact column whose
        901 MB is why this file is being touched at all. A measured RANGE rather than one number,
        because it depends entirely on how much of the payload is non-ASCII: ~1.5x for a mixed
        work-item payload, up to ~2.4x for prose that is mostly Polish, 3x being the bound. (The
        earlier "1.68x" was real but came from a payload nobody can find again, which makes it
        unverifiable and therefore worse than a range.)
        """
        if not request_body:
            return None
        decoded = self._safe_decode_body(request_body)
        if decoded is None or decoded in self.DECODE_SENTINELS:
            return decoded
        try:
            parsed = json.loads(decoded)
        except (ValueError, TypeError, RecursionError):
            return "[NOT JSON — DROPPED, MAY CONTAIN SECRETS]"
        if not isinstance(parsed, (dict, list)):
            return "[NON-OBJECT JSON — DROPPED, MAY CONTAIN SECRETS]"
        # The encode is INSIDE the try, and that is the whole point of this block. `json.loads`
        # accepts a lone surrogate escape, `ensure_ascii=False` then emits the raw surrogate, and
        # `str.encode("utf-8")` raises UnicodeEncodeError on it — so a 14-byte, pure-ASCII,
        # unnested body escaped into process_request's `except Exception` and suppressed the audit
        # row. Easier to trigger than the nesting bomb the depth bound fixed, and created BY the
        # ensure_ascii=False change: with the default escaping the surrogate becomes ASCII and
        # encodes fine. UnicodeEncodeError subclasses ValueError, so the existing except covers it
        # once the call is in scope. Measured 2026-11-05.
        try:
            redacted = json.dumps(self._redact_tree(parsed), ensure_ascii=False, separators=(",", ":"))
            encoded = redacted.encode("utf-8")
            if len(encoded) <= self.BODY_MAX_BYTES:
                return redacted
            return f"{encoded[: self.BODY_MAX_BYTES].decode('utf-8', errors='ignore')}… [truncated]"
        except (RecursionError, ValueError, TypeError):
            return "[UNREDACTABLE JSON — DROPPED, MAY CONTAIN SECRETS]"

    def _redact_tree(self, value, depth: int = 0):
        """Walk a parsed JSON value, redacting by key name.

        Depth-bounded, and the bound is not cosmetic. An unbounded walk raised `RecursionError` on
        a 2 KB body of nested brackets (measured 2026-11-05); `process_request`'s broad
        `except Exception` swallowed it, and **no audit row was written at all** — so an API-key
        holder could run a request that succeeded and leave no trace of it. Past the bound the
        subtree is replaced rather than walked: a payload nested deeper than this is not something
        this API has a use for.
        """
        if depth >= self.MAX_DEPTH:
            return "[TOO DEEP — NOT REDACTED, DROPPED]"
        if isinstance(value, dict):
            return {
                key: (self.REDACTED if self._is_sensitive_name(key) else self._redact_tree(item, depth + 1))
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._redact_tree(item, depth + 1) for item in value]
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
            # The exact list first, then the same word matcher the body and query string use. It
            # covers proxy-authorization, x-auth-token, x-amz-security-token,
            # cf-access-client-secret and the x-*-signature family without enumerating them — but
            # NOT everything: "authentication" and "x-csrftoken" do not match the word set, so
            # they are in the exact list. It also over-redacts idempotency-key and
            # sec-websocket-key; accepted.
            key: (self.REDACTED if key.lower() in self.SENSITIVE_HEADERS or self._is_sensitive_name(key) else value)
            for key, value in request.headers.items()
        }
        return str(redacted)

    @staticmethod
    def _storable_ip(request):
        """A value the `ip_address` (`inet`) column will accept, or None.

        `get_client_ip` returns the first comma-separated token of X-Forwarded-For unvalidated, so
        a non-IP value reaches the worker, the INSERT raises, `log_to_postgres` catches it and the
        row is lost — the same outcome as the redactor bugs above, one step later. Not reachable
        today because nginx overwrites that header with $remote_addr rather than appending it
        (APLANE-28); this is the other half of the warning that sits next to that directive.
        """
        raw = get_client_ip(request=request)
        try:
            # .strip() because X-Forwarded-For allows whitespace around its commas (RFC 7239), and
            # get_client_ip takes split(",")[0] verbatim — without it this guard would turn a
            # perfectly good "1.2.3.4 , 5.6.7.8" into None and lose data that used to store fine.
            return str(ipaddress.ip_address(raw.strip()))
        except (ValueError, TypeError, AttributeError):
            return None

    @staticmethod
    def _fits(value, limit: int):
        """Truncate to a column width. `method` is varchar(10), `path` 255 and `user_agent` 512,
        all three written unvalidated — an over-long value raises in the worker and loses the row
        exactly like everything else in this class."""
        return None if value is None else value[:limit]

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
                "path": self._fits(request.path, 255),
                "method": self._fits(request.method, 10),
                "query_params": self._redacted_query_string(request),
                "headers": self._redacted_headers(request),
                "body": self._redacted_body(request_body),
                "response_body": self._response_body_to_log(response),
                "response_code": response.status_code,
                "ip_address": self._storable_ip(request),
                "user_agent": self._fits(request.META.get("HTTP_USER_AGENT", None), 512),
            }

            process_logs.delay(log_data=log_data)

        except Exception as e:
            log_exception(e)

        return None
