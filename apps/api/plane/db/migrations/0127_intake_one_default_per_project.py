# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""One live default intake per project, enforced by the database (APLANE-38 step 3).

**This is the one migration in the series that can fail**, and it fails at apply time with an
IntegrityError naming the constraint: a partial unique constraint is rejected if a duplicate
already exists. That is why the ticket made measuring a precondition. Checked in prod 2026-11-09:

    select project_id, count(*) from intakes where deleted_at is null group by 1 having count(*) > 1;

returned no rows, so it applies cleanly here. Run that query first on any other instance.

The operation below is exactly what `makemigrations` generated — including the alphabetical order
of the Q children, which is what makes the model and the migration compare equal. Hand-writing it
with the conditions the other way round left `makemigrations --check` wanting to drop and recreate
the constraint on every later migration.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0126_intake_default_first_ordering")]

    operations = [
        migrations.AddConstraint(
            model_name="intake",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True), ("is_default", True)),
                fields=("project",),
                name="intake_one_default_per_project",
            ),
        )
    ]
