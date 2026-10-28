# L2: the auth throttle decorator must be importable and keep the handler's identity.
#
# #10059's throttle_auth_redirect came in through a hand-resolved conflict, and upstream's
# `from functools import wraps` sat in a hunk our tree did not have: the module then raised
# NameError at import time, which took down collection of every test that imports a view.

import pytest


@pytest.mark.unit
class TestThrottleAuthRedirect:
    def test_module_imports(self):
        from plane.authentication.rate_limit import throttle_auth_redirect

        assert callable(throttle_auth_redirect)

    def test_decorator_preserves_the_handler_identity(self):
        from plane.authentication.rate_limit import throttle_auth_redirect

        class View:
            @throttle_auth_redirect(is_app=True)
            def post(self, request):  # pragma: no cover - never called here
                return None

        # functools.wraps is what carries these over; without it DRF/Django introspection
        # and every error message point at the wrapper instead of the real handler
        assert View.post.__name__ == "post"
