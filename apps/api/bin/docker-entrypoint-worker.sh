#!/bin/bash
set -e

python manage.py wait_for_db
# Wait for migrations
python manage.py wait_for_migrations
# Run the processes
# Celery defaults --concurrency to the CPU count, and the AIO sees all 12 cores on VPS_PROD, so it
# forked 12 workers that each hold the whole Django app: ~143 MB RSS apiece, measured 2026-11-04,
# against the container's 2 GiB cap (gunicorn next to it runs -w 1). That is what tripped
# ContainerMemoryHigh at 87.9% on every deploy (AINF-531). Pin it instead of inheriting the host's
# core count, so the footprint does not change when the box does.
celery -A plane worker -l info --concurrency="${CELERY_WORKER_CONCURRENCY:-4}"
