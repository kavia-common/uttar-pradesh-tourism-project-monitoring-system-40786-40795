/// PUBLIC_INTERFACE
/**
 * Initialize MongoDB database: collections, indexes, seed data, and stub_info upsert.
 *
 * Usage:
 *  - Uses standardized env:
 *      - MONGODB_URL: MongoDB connection string including credentials and host/port (required)
 *      - MONGODB_DB: Target database name (required)
 *  - Run with: mongosh --file scripts/init_db.js --quiet
 *
 * Security:
 * - Connects using credentials from MONGODB_URL (least-privilege app user is acceptable for seeding).
 * - Performs only collection/index creation and data seeding operations.
 */
(function () {
  // Resolve environment variables
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const MONGO_URL = env.MONGODB_URL || "";
  const DB_NAME = env.MONGODB_DB || "";

  if (!MONGO_URL || !DB_NAME) {
    print("✗ Initialization error: MONGODB_URL and MONGODB_DB must be provided in environment.");
    throw new Error("Missing MONGODB_URL or MONGODB_DB");
  }

  // Helper for timestamps
  function nowIso() { return new Date().toISOString(); }

  // Connect using mongosh's Mongo constructor with the full URL
  function connectUsingUrl(url, dbName) {
    // Append db path if absent in the URL; preserve existing query string
    // If URL already has a path component, leave as is; otherwise append /dbName
    // MONGODB_URL generally looks like: mongodb://user:pwd@host:port/?authSource=admin
    let finalUrl = url;
    try {
      // crude parsing since mongosh here doesn't provide full URL API
      const noPrefix = url.replace(/^mongodb:\/\//, "");
      const firstSlash = noPrefix.indexOf("/");
      if (firstSlash === -1) {
        // no slash at all; append /dbName
        finalUrl = url + (url.endsWith("/") ? "" : "/") + dbName;
      } else {
        const pathAndQuery = noPrefix.substring(firstSlash + 1); // after first slash
        if (pathAndQuery.startsWith("?") || pathAndQuery.length === 0) {
          // only query string or empty; inject dbName before query
          const prefix = url.substring(0, url.indexOf("://") + 3);
          const hostPart = noPrefix.substring(0, firstSlash);
          const queryPart = pathAndQuery; // may start with ? or be empty
          finalUrl = prefix + hostPart + "/" + dbName + queryPart;
        } else {
          // already has a db segment; keep as-is
          finalUrl = url;
        }
      }
    } catch (e) {
      // On any parsing error, fallback to just appending "/DB_NAME"
      finalUrl = url + (url.endsWith("/") ? "" : "/") + dbName;
    }
    return new Mongo(finalUrl);
  }

  // Ensure indexes as per schema
  function ensureIndexes(db) {
    db.getCollection("users").createIndex({ email: 1 }, { name: "uniq_email", unique: true });
    db.getCollection("roles").createIndex({ code: 1 }, { name: "uniq_code", unique: true });
    db.getCollection("projects").createIndex({ code: 1 }, { name: "uniq_project_code" });
    db.getCollection("milestones").createIndex({ projectId: 1 }, { name: "idx_milestones_projectId" });
    db.getCollection("progress_logs").createIndex({ projectId: 1, date: -1 }, { name: "idx_progress_project_date" });
    db.getCollection("payments").createIndex({ projectId: 1, date: -1 }, { name: "idx_payments_project_date" });
    db.getCollection("documents").createIndex({ projectId: 1 }, { name: "idx_documents_projectId" });
    db.getCollection("reports").createIndex({ projectId: 1, generatedAt: -1 }, { name: "idx_reports_project_generated" });
    db.getCollection("audit_logs").createIndex({ entity: 1, entityId: 1, timestamp: -1 }, { name: "idx_audit_entity_ts" });
    db.getCollection("audit_logs").createIndex({ actorId: 1, timestamp: -1 }, { name: "idx_audit_actor_ts" });
  }

  // Seed data using provided seed file
  function seedData(db) {
    let seed = null;
    try {
      const path = "seed/seed_data.json";
      // eslint-disable-next-line no-undef
      seed = JSON.parse(cat(path));
    } catch (e) {
      print(`No seed file found or invalid JSON: ${e.message}`);
      seed = {};
    }

    const rolesMap = {};
    if (Array.isArray(seed.roles)) {
      seed.roles.forEach(r => {
        const existing = db.getCollection("roles").findOne({ code: r.code });
        if (!existing) {
          const doc = {
            code: r.code,
            name: r.name,
            permissions: r.permissions || [],
            createdAt: nowIso(),
            updatedAt: nowIso()
          };
          const ins = db.getCollection("roles").insertOne(doc);
          rolesMap[r.code] = ins.insertedId;
        } else {
          rolesMap[r.code] = existing._id;
        }
      });
    }

    if (Array.isArray(seed.users)) {
      seed.users.forEach(u => {
        if (!u.email) return;
        const existing = db.getCollection("users").findOne({ email: u.email });
        const roleIds = (u.roles || []).map(code => rolesMap[code]).filter(Boolean);
        if (!existing) {
          db.getCollection("users").insertOne({
            email: u.email,
            name: u.name || "",
            password_hash: u.password_hash || "",
            roleIds,
            status: "active",
            createdAt: nowIso(),
            updatedAt: nowIso()
          });
        }
      });
    }

    const projectIdByCode = {};
    if (Array.isArray(seed.projects)) {
      seed.projects.forEach(p => {
        if (!p.code) return;
        const existing = db.getCollection("projects").findOne({ code: p.code });
        if (!existing) {
          const doc = {
            code: p.code,
            name: p.name || "",
            description: p.description || "",
            status: p.status || "draft",
            department: p.department || "",
            budget: typeof p.budget === "number" ? p.budget : 0,
            startDate: p.startDate || null,
            endDate: p.endDate || null,
            location: p.location || null,
            createdBy: null,
            createdAt: nowIso(),
            updatedAt: nowIso()
          };
          const ins = db.getCollection("projects").insertOne(doc);
          projectIdByCode[p.code] = ins.insertedId;
        } else {
          projectIdByCode[p.code] = existing._id;
        }
      });
    }

    function resolveProjectId(item) {
      if (item.projectId) return item.projectId;
      if (item.projectCode && projectIdByCode[item.projectCode]) return projectIdByCode[item.projectCode];
      return null;
    }

    if (Array.isArray(seed.milestones)) {
      seed.milestones.forEach(m => {
        const projectId = resolveProjectId(m);
        if (!projectId) return;
        db.getCollection("milestones").insertOne({
          projectId,
          name: m.name || "",
          description: m.description || "",
          dueDate: m.dueDate || null,
          completionDate: m.completionDate || null,
          status: m.status || "not_started",
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      });
    }

    if (Array.isArray(seed.progress_logs)) {
      seed.progress_logs.forEach(pl => {
        const projectId = resolveProjectId(pl);
        if (!projectId) return;
        db.getCollection("progress_logs").insertOne({
          projectId,
          date: pl.date || nowIso(),
          percentComplete: typeof pl.percentComplete === "number" ? pl.percentComplete : 0,
          notes: pl.notes || "",
          geo: pl.geo || null,
          createdBy: null,
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      });
    }

    if (Array.isArray(seed.documents)) {
      seed.documents.forEach(d => {
        const projectId = resolveProjectId(d);
        if (!projectId) return;
        db.getCollection("documents").insertOne({
          projectId,
          title: d.title || "",
          type: d.type || "",
          url: d.url || "",
          uploadedBy: null,
          uploadedAt: nowIso()
        });
      });
    }

    if (Array.isArray(seed.payments)) {
      seed.payments.forEach(p => {
        const projectId = resolveProjectId(p);
        if (!projectId) return;
        db.getCollection("payments").insertOne({
          projectId,
          date: p.date || nowIso(),
          amount: typeof p.amount === "number" ? p.amount : 0,
          status: p.status || "initiated",
          reference: p.reference || "",
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      });
    }

    if (Array.isArray(seed.reports)) {
      seed.reports.forEach(r => {
        const projectId = resolveProjectId(r);
        if (!projectId) return;
        db.getCollection("reports").insertOne({
          projectId,
          type: r.type || "custom",
          generatedAt: r.generatedAt || nowIso(),
          payload: r.payload || {}
        });
      });
    }
  }

  // Seed or upsert stub_info document
  function upsertStubInfo(db) {
    const coll = db.getCollection("stub_info");
    // Upsert a simple ready marker document
    coll.updateOne(
      { name: "ready" },
      { $set: { name: "ready", ts: new Date() } },
      { upsert: true }
    );
    print("✓ stub_info upsert completed");
  }

  try {
    // Connect to DB using URL and DB name
    const conn = connectUsingUrl(MONGO_URL, DB_NAME);
    const db = conn.getDB(DB_NAME);

    // Touch required collections to ensure they exist
    ["users", "roles", "projects", "milestones", "progress_logs", "documents", "payments", "reports", "audit_logs", "stub_info"]
      .forEach(name => { db.getCollection(name).insertOne({ __bootstrap__: true }); db.getCollection(name).deleteOne({ __bootstrap__: true }); });

    // Ensure indexes
    ensureIndexes(db);

    // Seed domain data
    seedData(db);

    // Upsert stub_info as requested
    upsertStubInfo(db);

    print("✓ Database initialization complete (collections, indexes, seed, stub_info)");
  } catch (e) {
    print(`✗ Initialization error: ${e.message}`);
    throw e;
  }
})();
