# Keywords on inventory items (owner, 2026-11-23). Shipped dark ahead of the code that uses them, with
# db_default so an image from before this migration still inserts items after a rollback (M7).

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0129_fileasset_inventory_item"),
    ]

    operations = [
        migrations.AddField(
            model_name="inventoryitem",
            name="keywords",
            field=models.TextField(blank=True, db_default="", default=""),
        ),
        migrations.AddField(
            model_name="inventoryitem",
            name="keywords_normalised",
            field=models.TextField(db_default="", default="", editable=False),
        ),
    ]
