import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "../env";
import { databaseSchema } from "./schema";

const queryClient = postgres(serverEnv.databaseUrl, {
  prepare: false,
  max: 10,
});

export const db = drizzle(queryClient, {
  schema: databaseSchema,
});
