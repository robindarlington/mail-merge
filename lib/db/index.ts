/**
 * Barrel for the data layer. Web and worker import everything DB-related from
 * `@/lib/db`: the typed `db` client, the raw `connection` (the migration runner
 * in 01-05 and the worker may need the raw handle), and the full schema + row
 * types. lib/db is the only module that opens SQLite (D-04).
 */

export { db, connection, type Db } from "./client";
export * from "./schema";
