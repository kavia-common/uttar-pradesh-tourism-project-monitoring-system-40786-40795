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

echo "[startup] Starting MongoDB setup..."
echo "[startup] Using MONGODB_URL=${MONGODB_URL}"
echo "[startup] Using MONGODB_DB=${MONGODB_DB}"
echo "[startup] Target host: ${DB_HOST}, port: ${DB_PORT}"

# Check if MongoDB is already running
if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    echo "[startup] MongoDB is already running on ${DB_HOST}:${DB_PORT}"
    if mongosh "${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}" --eval "db.getName()" > /dev/null 2>&1; then
        echo "[startup] Database ${MONGODB_DB} is accessible."
    else
        echo "[startup] MongoDB is running but authentication might not be configured."
    fi
else
  # If mongod already running on different port, stop it (local-only safety)
  if pgrep -x mongod > /dev/null; then
      echo "[startup] MongoDB appears to be running on a different port; attempting graceful stop..."
      sudo pkill -x mongod || true
      sleep 2
  fi

  # Clean up any existing socket files
  sudo rm -f /tmp/mongodb-*.sock 2>/dev/null || true

  # Start local MongoDB server (bind to localhost)
  echo "[startup] Starting MongoDB server on ${DB_HOST}:${DB_PORT}..."
  nohup sudo mongod --dbpath /var/lib/mongodb --port ${DB_PORT} --bind_ip 127.0.0.1 --unixSocketPrefix /var/run/mongodb > /var/lib/mongodb/mongod.log 2>&1 &

  # Wait for MongoDB to start with clear logs
  echo "[startup] Waiting for MongoDB to accept connections on ${DB_HOST}:${DB_PORT}..."
  MONGO_READY=0
  for i in {1..30}; do
      if mongosh --host "${DB_HOST}" --port "${DB_PORT}" --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
          echo "[startup] ✓ MongoDB ready"
          echo "[startup] MongoDB ready"  # explicit log as requested
          MONGO_READY=1
          break
      fi
      echo "[startup] ... MongoDB not ready yet ($i/30). Retrying in 2s"
      sleep 2
  done

  if [ "${MONGO_READY}" -ne 1 ]; then
      echo "[startup] ✗ MongoDB did not become ready in time. Last log lines:"
      tail -n 50 /var/lib/mongodb/mongod.log 2>/dev/null || echo "(no mongod log found)"
      exit 1
  fi
fi

# Derive admin user to create (use provided DB_USER from URL or default)
ADMIN_USER="${DB_USER}"
ADMIN_PWD="${DB_PASSWORD}"
APP_USER="appuser"
APP_PWD="${DB_PASSWORD}"

# Create admin and app users
echo "[startup] Setting up admin and app users..."
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
echo "[startup] Connection string saved to db_connection.txt"

# Save environment variables for db viewer and other tools
cat > db_visualizer/mongodb.env << EOF
export MONGODB_URL="${MONGODB_URL}"
export MONGODB_DB="${MONGODB_DB}"
EOF
echo "[startup] Wrote db_visualizer/mongodb.env"

echo "[startup] Running database initialization (collections, indexes, seed, stub_info upsert)..."
# Export env vars for init script (scripts/init_db.js expects these)
export MONGODB_DB="${MONGODB_DB}"
export MONGODB_URL="${MONGODB_URL}"

# Execute init script with mongosh
if mongosh --file scripts/init_db.js --quiet; then
    echo "[startup] ✓ Database initialization completed."
else
    echo "[startup] ⚠ Database initialization encountered issues. Check logs above."
fi

echo ""
echo "[startup] MongoDB setup complete!"
echo "[startup] Database: ${MONGODB_DB}"
echo "[startup] Connection URL: ${MONGODB_URL}"
echo "[startup] Port: ${DB_PORT}"
echo ""

# ---- Optional: Start DB Visualizer (best-effort, does NOT affect readiness) ----
echo "[startup] Attempting to start optional DB visualizer on port 3020 (best-effort)..."
echo "[startup] Visualizer is optional; not required for readiness."
VISUALIZER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/db_visualizer"

(
  cd "${VISUALIZER_DIR}" || exit 0
  # shellcheck disable=SC1091
  source mongodb.env 2>/dev/null || true
  export PORT="${PORT:-3020}"
  export HOST="0.0.0.0"
  LOG_FILE="/tmp/db_visualizer.log"

  echo "[db_visualizer] Launching server (PORT=${PORT}, HOST=${HOST})" | tee -a "${LOG_FILE}"

  if [ ! -d "node_modules" ] && command -v npm >/dev/null 2>&1; then
    echo "[db_visualizer] node_modules missing. Installing dependencies..." | tee -a "${LOG_FILE}"
    npm ci --only=production >> "${LOG_FILE}" 2>&1 || npm install --production >> "${LOG_FILE}" 2>&1 || true
  fi

  if command -v npm >/dev/null 2>&1; then
    nohup npm run start >> "${LOG_FILE}" 2>&1 &
    echo "[db_visualizer] Started via npm (pid=$!)" | tee -a "${LOG_FILE}"
  elif command -v node >/dev/null 2>&1; then
    nohup node server.js >> "${LOG_FILE}" 2>&1 &
    echo "[db_visualizer] Started via node (pid=$!)" | tee -a "${LOG_FILE}"
  else
    echo "[db_visualizer] ⚠ Node.js runtime not found. DB visualizer cannot start." | tee -a "${LOG_FILE}"
  fi
) || echo "[startup] ⚠ Failed to launch DB visualizer. See /tmp/db_visualizer.log"

# ---- Readiness: PASS based on MongoDB only ----
echo "[startup] Performing readiness check based solely on MongoDB availability..."
READINESS_OK=0
# Primary: mongosh ping using provided URL/DB
if mongosh "${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}" --eval "db.runCommand({ ping: 1 })" > /dev/null 2>&1; then
  echo "[startup] ✓ Readiness: MongoDB ping succeeded"
  echo "[startup] MongoDB ready"
  READINESS_OK=1
fi

# Informational status of visualizer only (not used for readiness)
if curl -sf "http://127.0.0.1:3020/health" >/dev/null 2>&1; then
  echo "[startup] (info) DB visualizer is up on http://localhost:3020"
else
  echo "[startup] (info) Visualizer is optional; not required for readiness."
fi

if [ "${READINESS_OK}" -eq 1 ]; then
  echo "[startup] ✓ Readiness PASS: MongoDB is accepting connections"
else
  echo "[startup] ✗ Readiness FAIL: MongoDB not reachable via provided URL"
  exit 1
fi

echo "[startup] To connect to MongoDB:"
echo "mongosh \"${MONGODB_URL}${MONGODB_URL*+/$MONGODB_DB}\""
echo "[startup] Startup complete."
