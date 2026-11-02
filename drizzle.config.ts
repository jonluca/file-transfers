import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema/*.ts",
  out: "./server/db/d1-migrations",
  verbose: true,
  strict: true,
});
