import { defineConfig } from "drizzle-kit";

// drizzle-kit reads this to generate and apply migrations.
// The schema itself is authored in plan 01-02 at lib/db/schema.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/app.db",
  },
  strict: true,
  verbose: true,
});
