/// PUBLIC_INTERFACE
/**
 * Initialize MongoDB database: collections, indexes, and seed data.
 *
 * Usage:
 *  MONGODB_URL and MONGODB_DB can be provided via environment or defaults from startup.sh.
 *  Run with: mongosh --file scripts/init_db.js --quiet
 *
 * Security:
 * - Uses admin user only for index/collection setup when needed.
 * - Uses appuser for data seeding to honor least-privilege.
 */
(function () {
  // Resolve environment and defaults (these are echoed by startup.sh into db_visualizer/mongodb.env)
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const DB_NAME = env.MONGODB_DB || "myapp";
  const PORT = env.DB_PORT || "5000";
  const ADMIN_USER = env.DB_USER || "appuser"; // will be admin user in startup.sh
  const ADMIN_PWD = env.DB_PASSWORD || "dbuser123";
  const APP_USER = "appuser";
  const APP_PWD = ADMIN_PWD;

  function nowIso() { return new Date().toISOString(); }

  // Connect helpers
  function connectAdmin() {
    const uri = `mongodb://${ADMIN_USER}:${ADMIN_PWD}@localhost:${PORT}/${DB_NAME}?authSource=admin`;
    return new Mongo(uri);
  }
  function connectApp() {
    const uri = `mongodb://${APP_USER}:${APP_PWD}@localhost:${PORT}/${DB_NAME}?authSource=admin`;
    return new Mongo(uri);
  }

  // Define required indexes as per acceptance criteria and schema
  function ensureIndexes(db) {
    // users.email unique
    db.getCollection("users").createIndex({ email: 1 }, { name: "uniq_email", unique: true });

    // roles.code unique (from schema)
    db.getCollection("roles").createIndex({ code: 1 }, { name: "uniq_code", unique: true });

    // projects.code unique
    db.getCollection("projects").createIndex({ code: 1 }, { name: "uniq_project_code", unique: true });

    // milestones.projectId
    db.getCollection("milestones").createIndex({ projectId: 1 }, { name: "idx_milestones_projectId" });

    // progress_logs.projectId + date
    db.getCollection("progress_logs").createIndex({ projectId: 1, date: -1 }, { name: "idx_progress_project_date" });

    // payments.projectId + date
    db.getCollection("payments").createIndex({ projectId: 1, date: -1 }, { name: "idx_payments_project_date" });

    // documents.projectId
    db.getCollection("documents").createIndex({ projectId: 1 }, { name: "idx_documents_projectId" });

    // reports (from schema, useful for analytics)
    db.getCollection("reports").createIndex({ projectId: 1, generatedAt: -1 }, { name: "idx_reports_project_generated" });

    // audit_logs (from schema)
    db.getCollection("audit_logs").createIndex({ entity: 1, entityId: 1, timestamp: -1 }, { name: "idx_audit_entity_ts" });
    db.getCollection("audit_logs").createIndex({ actorId: 1, timestamp: -1 }, { name: "idx_audit_actor_ts" });
  }

  // Seed data using appuser
  function seedData(db) {
    // Load external seed file if present
    let seed = null;
    try {
      const path = "seed/seed_data.json";
      // eslint-disable-next-line no-undef
      seed = JSON.parse(cat(path));
    } catch (e) {
      print(`No seed file found or invalid JSON: ${e.message}`);
      seed = {};
    }

    // Seed roles
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

    // Seed users (password_hash is a placeholder hash; backend should manage real auth)
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

    // Seed projects
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

    // Helper to resolve projectId from seed item with projectCode
    function resolveProjectId(item) {
      if (item.projectId) return item.projectId;
      if (item.projectCode && projectIdByCode[item.projectCode]) return projectIdByCode[item.projectCode];
      return null;
    }

    // Seed milestones
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

    // Seed progress logs
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

    // Seed documents
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

    // Seed payments
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

    // Seed reports
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

    // No seed for audit_logs; it fills during runtime
  }

  // Execution
  try {
    // Ensure collections exist by touching them via admin
    const adminConn = connectAdmin();
    const adminDb = adminConn.getDB(DB_NAME);
    ["users", "roles", "projects", "milestones", "progress_logs", "documents", "payments", "reports", "audit_logs"]
      .forEach(name => { adminDb.getCollection(name).insertOne({ __bootstrap__: true }); adminDb.getCollection(name).deleteOne({ __bootstrap__: true }); });

    // Indexes via admin
    ensureIndexes(adminDb);

    // Seed using app user (least-privilege)
    const appConn = connectApp();
    const appDb = appConn.getDB(DB_NAME);
    seedData(appDb);

    print("✓ Database initialization complete (collections, indexes, seed)");
  } catch (e) {
    print(`✗ Initialization error: ${e.message}`);
    throw e;
  }
})();
