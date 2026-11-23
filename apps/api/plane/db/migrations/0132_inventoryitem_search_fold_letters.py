# The search fold now maps ł→l (and đ ø ı ħ ŧ) too, owner 2026-11-23: refill the search text of every row, as 0131
# did. Data only; an older image ignores it. The fold is copied, not imported: a migration must not change when the
# model code does.

import unicodedata

from django.db import migrations

_BASE_LETTERS = str.maketrans({"ł": "l", "đ": "d", "ø": "o", "ı": "i", "ħ": "h", "ŧ": "t"})


def _fold(text):
    t = " ".join(unicodedata.normalize("NFKC", text or "").split()).casefold()
    d = unicodedata.normalize("NFKD", t)
    return unicodedata.normalize("NFC", "".join(ch for ch in d if not unicodedata.combining(ch))).translate(
        _BASE_LETTERS
    )


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
        ("db", "0131_inventoryitem_search_text"),
    ]

    operations = [migrations.RunPython(fill, migrations.RunPython.noop)]
