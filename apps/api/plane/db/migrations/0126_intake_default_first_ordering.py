# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Order intakes with the default first (APLANE-38).

`AlterModelOptions` only — Django stores `ordering` in model state, so this emits no SQL and
touches no row. It exists so the model state matches the code; without it `makemigrations --check`
reports a pending change for every later migration author (verified: with it, "No changes
detected").

Not "cannot fail": an upstream merge that lands its own 0126 leaf needs `makemigrations --merge`.
And the suite never applies it — `pytest.ini` sets `--nomigrations`, so the schema is built from
models, and nothing in the repo runs `makemigrations --check`.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("db", "0125_reset_project_deploy_board_identity")]

    operations = [
        migrations.AlterModelOptions(
            name="intake",
            options={
                "ordering": ("-is_default", "name"),
                "verbose_name": "Intake",
                "verbose_name_plural": "Intakes",
            },
        )
    ]
