// Turso (libSQL) — menampung tabel "berat" (Laporan Harian + Invest) yang
// dipindah dari Cloudflare D1 supaya D1 tidak kena limit "rows read" 5 juta/hari.
//
// Shim ini meniru antarmuka D1Database yang dipakai kode lap/invest:
//   getTurso(env).prepare(sql).bind(...args).run() | .all<T>() | .first<T>()
//   getTurso(env).batch([stmt, ...])
// jadi migrasi cukup ganti `env.DB` -> `getTurso(env)` di modul terkait.
import { createClient, type Client, type InArgs } from "@libsql/client/web";

let _client: Client | null = null;

// Secret bisa terbawa BOM / spasi kalau di-set lewat pipe PowerShell.
const scrub = (v: string | undefined): string => String(v ?? "").replace(/^﻿/, "").trim();

function client(env: Env): Client {
	if (!_client) {
		const url = scrub(env.TURSO_URL);
		const authToken = scrub(env.TURSO_TOKEN);
		if (!url || !authToken) {
			throw new Error("Turso belum dikonfigurasi (TURSO_URL / TURSO_TOKEN). Hubungi admin.");
		}
		_client = createClient({ url, authToken });
	}
	return _client;
}

const clean = (args: unknown[]): InArgs => args.map((a) => (a === undefined ? null : a)) as InArgs;

class TStmt {
	constructor(
		readonly c: Client,
		readonly sql: string,
		readonly args: unknown[] = [],
	) {}
	bind(...args: unknown[]): TStmt {
		return new TStmt(this.c, this.sql, args);
	}
	async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number; duration: number } }> {
		const rs = await this.c.execute({ sql: this.sql, args: clean(this.args) });
		return { success: true, meta: { changes: rs.rowsAffected ?? 0, last_row_id: Number(rs.lastInsertRowid ?? 0), duration: 0 } };
	}
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const rs = await this.c.execute({ sql: this.sql, args: clean(this.args) });
		return { results: rs.rows as unknown as T[], success: true, meta: {} };
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const rs = await this.c.execute({ sql: this.sql, args: clean(this.args) });
		return (rs.rows[0] as unknown as T) ?? null;
	}
}

class TDB {
	constructor(readonly c: Client) {}
	prepare(sql: string): TStmt {
		return new TStmt(this.c, sql);
	}
	async batch(stmts: TStmt[]): Promise<{ success: true; meta: { changes: number; last_row_id: number } }[]> {
		const rs = await this.c.batch(
			stmts.map((s) => ({ sql: s.sql, args: clean(s.args) })),
			"write",
		);
		return rs.map((r) => ({ success: true as const, meta: { changes: r.rowsAffected ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } }));
	}
}

export function getTurso(env: Env): TDB {
	return new TDB(client(env));
}
