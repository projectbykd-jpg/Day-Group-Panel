// Migrasi tabel berat D1 -> Turso (sekali jalan).
//   node scripts/migrate-to-turso.mjs <TURSO_URL> <TURSO_TOKEN> <dir-berisi-t_*.json>
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const HERE = dirname(fileURLToPath(import.meta.url));

const [, , URL_, TOKEN_, DATA_DIR] = process.argv;
if (!URL_ || !TOKEN_ || !DATA_DIR) {
	console.error("Usage: node scripts/migrate-to-turso.mjs <url> <token> <data-dir>");
	process.exit(1);
}

const db = createClient({ url: URL_, authToken: TOKEN_ });
const schema = readFileSync(resolve(HERE, "..", "..", "migration", "turso_001_schema.sql"), "utf8");

const stmts = schema
	.split(/;\s*(?:\n|$)/)
	.map((s) => s.replace(/--[^\n]*\n/g, "\n").trim())
	.filter(Boolean);
for (const s of stmts) await db.execute(s);
console.log(`skema OK (${stmts.length} statement)`);

const TABLES = ["lap_credentials", "lap_result", "lap_job", "invest_config", "invest_state", "invest_result", "invest_raw"];

const readRows = (t) => {
	const j = JSON.parse(readFileSync(resolve(DATA_DIR, `t_${t}.json`), "utf8").replace(/^﻿/, ""));
	const arr = Array.isArray(j) ? j : [j];
	return (arr[0] && arr[0].results) || [];
};

for (const t of TABLES) {
	const rows = readRows(t);
	if (!rows.length) {
		console.log(`${t}: 0 baris`);
		continue;
	}
	const cols = Object.keys(rows[0]);
	const sql = `INSERT OR REPLACE INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
	const batch = rows.map((r) => ({ sql, args: cols.map((c) => (r[c] === undefined ? null : r[c])) }));
	for (let i = 0; i < batch.length; i += 100) await db.batch(batch.slice(i, i + 100), "write");
	console.log(`${t}: ${rows.length} baris`);
}

console.log("--- verifikasi di Turso ---");
for (const t of TABLES) {
	const r = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
	console.log(`  ${t}: ${r.rows[0].n}`);
}
console.log("SELESAI");
