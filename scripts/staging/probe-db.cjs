/* Probes local PostgreSQL with common credentials and reports which works. */
const { execSync } = require("node:child_process");
const candidates = [
  "postgresql://postgres:postgres@localhost:5432/postgres",
  "postgresql://postgres:admin@localhost:5432/postgres",
  "postgresql://postgres:1234@localhost:5432/postgres",
  "postgresql://odoo:odoo@localhost:5432/postgres",
  "postgresql://postgres:odoo@localhost:5432/postgres",
  "postgresql://openpg:openpg@localhost:5432/postgres",
  "postgresql://postgres:postgres@127.0.0.1:5432/odoo",
];
for (const url of candidates) {
  try {
    execSync(`npx prisma db execute --stdin --schema prisma/schema.prisma`, {
      input: "SELECT 1;",
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
    console.log("WORKS:", url.replace(/:[^:@]+@/, ":***@"));
    process.exit(0);
  } catch (e) {
    console.log("fail:", url.replace(/:[^:@]+@/, ":***@"));
  }
}
console.log("NO_CREDENTIALS_WORKED");
