# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework.throttling import AnonRateThrottle


class InstanceReadThrottle(AnonRateThrottle):
    """GET /api/instances/ on its own bucket (APLANE-70).

    The session middleware reads the ADMIN cookie under /api/instances/ (it was any path containing
    "instances" until APLANE-71), so every signed-in page
    load of the web app reaches this endpoint as anonymous and counted against the 30/minute anonymous budget:
    measured on dev 2026-11-20, a valid session got 30 × 200 then 429 from the 31st request, and a 429 here is
    the "Plane didn't start up correctly" screen. The answer is public and cached for two hours, so the
    budget only needs to stop abuse, not normal use.
    """

    scope = "instance_read"
