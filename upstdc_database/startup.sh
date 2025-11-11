#!/bin/bash
set -e

# Standardized MongoDB startup using env vars:
# - MONGODB_URL: mongodb://USER:PASSWORD@HOST:PORT/?authSource=admin
# - MONGODB_DB: database name (e.g., myapp)
#
# Defaults for local development if not provided
MONGODB_URL="${MONGODB_URL:-mongodb://appuser:dbuser123@localhost:5000/?authSource=admin}"
MONGODB_DB="${MONGODB_DB:-myapp}"

# Parse URL parts needed by local mongod and user creation
# Expect format: mongodb://USER:PASSWORD@HOST:PORT/?authSource=admin
URL_NO_PREFIX="${MONGODB_URL#mongodb://}"
CRED_HOST_PORT="${URL_NO_PREFIX%%/*}"     # user:pwd@host:port OR host:port if no cred
QUERY_PART="${URL_NO_PREFIX#*/}"          # ?authSource=admin (ignored)
if [[ "$CRED_HOST_PORT" == *"@"* ]]; then
  CREDS="${CRED_HOST_PORT%@*}"
  HOST_PORT="${CRED_HOST_PORT#*@}"
  DB_USER="${CREDS%%:*}"
  DB_PASSWORD="${CREDS#*:}"
else
  HOST_PORT="${CRED_HOST_PORT}"
  DB_USER="appuser"
  DB_PASSWORD="dbuser123"
fi
DB_HOST="${HOST_PORT%%:*}"
DB_PORT="${HOST_PORT##*:}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5000}"

echo "Starting MongoDB setup..."
echo "Using MONGODB_URL=${MONGODB_URL}"
echo "Using MONGODB_DB=${MONGODB_DB}"

# Check if MongoDB is already running
if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    echo "MongoDB is already running on ${DB_HOST}:${DB_PORT}!"
    if mongosh "${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}" --eval "db.getName()" > /dev/null 2>&1; then
        echo "Database ${MONGODB_DB} is accessible."
    else
        echo "MongoDB is running but authentication might not be configured."
    fi
    echo ""
    echo "Database: ${MONGODB_DB}"
    echo "Connection URL: ${MONGODB_URL}"
    echo ""
    echo "To connect to the database, use:"
    echo "mongosh \"${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}${MONGODB_URL*+?authSource=admin}\""
    echo ""
    echo "Script stopped - MongoDB server already running."
    exit 0
fi

# If mongod already running on different port, stop it (local-only safety)
if pgrep -x mongod > /dev/null; then
    echo "MongoDB appears to be running on a different port; attempting graceful stop..."
    sudo pkill -x mongod || true
    sleep 2
fi

# Clean up any existing socket files
sudo rm -f /tmp/mongodb-*.sock 2>/dev/null || true

# Start local MongoDB server (bind to localhost)
echo "Starting MongoDB server on ${DB_HOST}:${DB_PORT}..."
nohup sudo mongod --dbpath /var/lib/mongodb --port ${DB_PORT} --bind_ip 127.0.0.1 --unixSocketPrefix /var/run/mongodb > /var/lib/mongodb/mongod.log 2>&1 &

# Wait for MongoDB to start
echo "Waiting for MongoDB to start..."
for i in {1..15}; do
    if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
        echo "MongoDB is ready!"
        break
    fi
    echo "Waiting... ($i/15)"
    sleep 2
done

# Derive admin user to create (use provided DB_USER from URL or default)
ADMIN_USER="${DB_USER}"
ADMIN_PWD="${DB_PASSWORD}"
APP_USER="appuser"
APP_PWD="${DB_PASSWORD}"

# Create admin and app users
echo "Setting up admin and app users..."
mongosh --host "${DB_HOST}" --port "${DB_PORT}" << EOF
use admin
if (db.getUser("${ADMIN_USER}") == null) {
  db.createUser({
    user: "${ADMIN_USER}",
    pwd: "${ADMIN_PWD}",
    roles: [
      { role: "userAdminAnyDatabase", db: "admin" },
      { role: "readWriteAnyDatabase", db: "admin" }
    ]
  });
}
use ${MONGODB_DB}
if (db.getUser("${APP_USER}") == null) {
  db.createUser({
    user: "${APP_USER}",
    pwd: "${APP_PWD}",
    roles: [{ role: "readWrite", db: "${MONGODB_DB}" }]
  });
}
print("MongoDB setup complete!");
EOF

# Save connection command to a file
echo "mongosh ${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}" > db_connection.txt
echo "Connection string saved to db_connection.txt"

# Save environment variables for db viewer and other tools
cat > db_visualizer/mongodb.env << EOF
export MONGODB_URL="${MONGODB_URL}"
export MONGODB_DB="${MONGODB_DB}"
EOF

echo "Running database initialization (collections, indexes, seed)..."
# Export env vars for init script (scripts/init_db.js expects these)
export MONGODB_DB="${MONGODB_DB}"
export DB_PORT="${DB_PORT}"
export DB_USER="${ADMIN_USER}"
export DB_PASSWORD="${ADMIN_PWD}"

# Execute init script with mongosh
if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --file scripts/init_db.js --quiet; then
    echo "✓ Database initialization completed."
else
    echo "⚠ Database initialization encountered issues. Check logs above."
fi

echo ""
echo "MongoDB setup complete!"
echo "Database: ${MONGODB_DB}"
echo "Connection URL: ${MONGODB_URL}"
echo "Port: ${DB_PORT}"
echo ""
echo "Environment variables saved to db_visualizer/mongodb.env"
echo "To use with Node.js viewer, run: source db_visualizer/mongodb.env"
echo "To connect to the database, use:"
echo "mongosh \"${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}\""
echo ""
echo "MongoDB is running in the background."
echo "You can now start your application."