# keywords_normalised becomes the search text (folded name + line break + folded keywords): filled here for the
# rows from before, which hold '' (0130's db_default). Data only, no schema change; an older image ignores it, and
# rows it saves meanwhile keep keywords only: the search also matches name_normalised for them.
# The fold is copied, not imported: a migration must not change when the model code does.

import unicodedata

from django.db import migrations


def _fold(text):
    t = " ".join(unicodedata.normalize("NFKC", text or "").split()).casefold()
    d = unicodedata.normalize("NFKD", t)
    return unicodedata.normalize("NFC", "".join(ch for ch in d if not unicodedata.combining(ch)))


def fill(apps, schema_editor):
    # _base_manager: every row, soft-deleted too (the live model's objects hides them).
    Item = apps.get_model("db", "InventoryItem")
    batch = []
    for item in Item._base_manager.only("pk", "name", "keywords").iterator(chunk_size=500):
        item.keywords_normalised = _fold(item.name) + "\n" + _fold(item.keywords)
        batch.append(item)
        if len(batch) == 500:
            Item._base_manager.bulk_update(batch, ["keywords_normalised"])
            batch = []
    if batch:
        Item._base_manager.bulk_update(batch, ["keywords_normalised"])


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0130_inventoryitem_keywords"),
    ]

    operations = [migrations.RunPython(fill, migrations.RunPython.noop)]
