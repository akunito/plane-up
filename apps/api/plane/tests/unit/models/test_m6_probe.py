# PHASE 0 SPIKE (APLANE-58, M6), never merge.
import pytest
from django.db import connection

from plane.db.models import M6Probe, Project


@pytest.mark.unit
@pytest.mark.django_db
def test_probe_table_and_flag_exist():
    assert M6Probe._meta.db_table == "m6_probes"
    assert Project._meta.get_field("m6_probe_flag").db_default is not None
    with connection.cursor() as cur:
        cur.execute("select 1 from information_schema.tables where table_name = 'm6_probes'")
        assert cur.fetchone() is not None
