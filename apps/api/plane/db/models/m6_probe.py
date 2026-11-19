# PHASE 0 SPIKE (APLANE-58, M6), never merge: a throwaway model with rows that reference a workspace
# and a project, to see what the deploy gate does when dev holds rows of a model an image does not know.
from uuid import uuid4

from django.db import models


class M6Probe(models.Model):
    id = models.UUIDField(default=uuid4, primary_key=True, editable=False)
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE, related_name="+")
    note = models.CharField(max_length=64)

    class Meta:
        db_table = "m6_probes"
