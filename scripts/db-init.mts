/**
 * Creates the schema up front: `npm run db:init`.
 *
 * Signing in does this lazily too, so this script is a convenience — useful to
 * confirm the connection string works before involving Slack, and to apply the
 * schema to a fresh database without waiting for the first sign-in.
 */
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const { db, ensureSchema } = await import("../src/lib/db.ts");

await ensureSchema();

const sql = db();
const tables = (await sql`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
  order by table_name
`) as { table_name: string }[];

console.log("Schema ready. Tables in public:");
for (const { table_name } of tables) console.log(`  - ${table_name}`);
