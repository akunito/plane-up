# L2 (APLANE-15): the internal API accepts an API key, not only a session cookie.
#
# Our integrations (the Telegram bot, n8n, the test suite) call /api/... with X-Api-Key.
# This lived as a sed patch applied at container start; these tests are what replaces the
# "anchor broken" guard that patch carried.

import pytest

from plane.api.middleware.api_authentication import APIKeyAuthentication
from plane.app.views.base import BaseAPIView, BaseViewSet
from plane.authentication.session import BaseSessionAuthentication


@pytest.mark.unit
class TestInternalApiKeyAuthentication:
    @pytest.mark.parametrize("view_class", [BaseViewSet, BaseAPIView])
    def test_base_views_accept_api_key(self, view_class):
        assert APIKeyAuthentication in view_class.authentication_classes

    @pytest.mark.parametrize("view_class", [BaseViewSet, BaseAPIView])
    def test_session_auth_is_kept_and_stays_first(self, view_class):
        # Order matters: a browser request must be answered by the session backend, which is
        # the one that knows about CSRF. The key is the fallback, never the first word.
        classes = view_class.authentication_classes
        assert classes[0] is BaseSessionAuthentication

    def test_every_internal_view_inherits_it(self):
        # A subclass that re-declares authentication_classes would silently lose the key, so
        # check the ones the integrations actually hit rather than trusting inheritance.
        from plane.app.views import IssueViewSet, ProjectViewSet

        for view_class in (IssueViewSet, ProjectViewSet):
            assert APIKeyAuthentication in view_class.authentication_classes, view_class.__name__
