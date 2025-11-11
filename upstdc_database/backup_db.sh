#!/bin/bash
# Universal Database Backup Script (standardized env)
# Uses:
# - MONGODB_URL: mongodb://USER:PASSWORD@HOST:PORT/?authSource=admin
# - MONGODB_DB: database name

DB_NAME="${MONGODB_DB:-myapp}"
MONGODB_URL="${MONGODB_URL:-mongodb://appuser:dbuser123@localhost:5000/?authSource=admin}"

# Derive host/port for health check
URL_NO_PREFIX="${MONGODB_URL#mongodb://}"
CRED_HOST_PORT="${URL_NO_PREFIX%%/*}"
if [[ "$CRED_HOST_PORT" == *"@"* ]]; then
  HOST_PORT="${CRED_HOST_PORT#*@}"
else
  HOST_PORT="${CRED_HOST_PORT}"
fi
DB_HOST="${HOST_PORT%%:*}"
DB_PORT="${HOST_PORT##*:}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5000}"

# MongoDB check and backup
if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    echo "Backing up MongoDB database..."
    mongodump --uri "${MONGODB_URL}${MONGODB_URL*+/$DB_NAME}" \
        --archive=database_backup.archive --quiet
    echo "✓ Backup saved to database_backup.archive"
    exit 0
fi

echo "⚠ No running MongoDB detected on ${DB_HOST}:${DB_PORT}"
echo "Make sure your database is running before creating a backup"
exit 1
