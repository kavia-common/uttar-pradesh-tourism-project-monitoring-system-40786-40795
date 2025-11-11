# UPSTDC Project Monitoring - Database (MongoDB)

This container hosts the MongoDB database for the UPSTDC Project Monitoring System.

Contents:
- schema/collections.json: Canonical collection definitions and indexes.
- seed/seed_data.json: Initial roles, admin user, and sample project data.
- scripts/init_db.js: Initialization script to create collections, enforce indexes, and seed data.
- backup_db.sh and restore_db.sh: Universal backup/restore scripts with MongoDB support.
- db_visualizer/: Simple database viewer helper (optional).

Environment
- MONGODB_URL: MongoDB connection string (e.g., mongodb://appuser:dbuser123@localhost:5000/?authSource=admin)
- MONGODB_DB: Database name (default: myapp)

Startup
- The startup.sh script:
  1) Starts mongod on port 5000 (localhost) if not already running
  2) Creates admin user and least-privilege app user for the target DB
  3) Runs scripts/init_db.js after server is ready to:
     - Create all required indexes:
       - users.email unique
       - projects.code unique
       - milestones.projectId
       - progress_logs.projectId+date
       - payments.projectId+date
       - documents.projectId
       - plus additional useful indexes for reports and audit logs per schema
     - Seed base data from seed/seed_data.json

How to initialize
- Run:
  ./upstdc_database/startup.sh

How to back up
- From the upstdc_database directory:
  ./backup_db.sh
- Produces database_backup.archive for MongoDB.

How to restore
- Place a valid database_backup.archive in the same directory.
- Run:
  ./restore_db.sh

Schema overview
- Collections:
  users, roles, projects, milestones, progress_logs, documents, payments, reports, audit_logs
- See schema/collections.json for field descriptions and index definitions.

Security notes
- The init script uses the admin account only for creating collections and indexes.
- Data seeding is performed using the least-privilege app user (readWrite on the application DB).

Troubleshooting
- Ensure mongosh and mongod are available.
- Default port is 5000 in scripts.
- Connection hint:
  mongosh mongodb://appuser:dbuser123@localhost:5000/myapp?authSource=admin