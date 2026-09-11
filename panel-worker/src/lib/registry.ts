// Anti-duplikat kirim result — tabel sent_registry (port getRegistryEntry_ / saveOrUpdateSentRegistry_).
// Di Turso (bukan D1): setiap kirim result (operator manual/auto) baca+tulis
// tabel ini -> paling sering dipanggil di seluruh app, growth tak terbatas
// tanpa pruning. Dipindah spy tidak makan kuota rows-read/write harian D1.
import { tsNow } from "./time";
import { getTurso } from "./turso";

export interface RegEntry {
	hash: string;
	website: string;
	username: string;
	market: string;
	telegram: boolean;
	linktree: boolean;
	panelz: boolean;
	sentAt: string;
}

export async function getRegistryEntry(
	env: Env,
	website: string,
	hash: string,
): Promise<RegEntry | null> {
	const w = String(website ?? "").trim().toUpperCase();
	const r = await getTurso(env).prepare(`SELECT * FROM sent_registry WHERE hash = ? AND website = ?`)
		.bind(hash, w)
		.first<Record<string, unknown>>();
	if (!r) return null;
	return {
		hash: String(r.hash ?? ""),
		website: w,
		username: String(r.username ?? ""),
		market: String(r.market ?? ""),
		telegram: !!r.telegram,
		linktree: !!r.linktree,
		panelz: !!r.panelz,
		sentAt: String(r.sent_at ?? ""),
	};
}

export async function upsertRegistry(
	env: Env,
	hash: string,
	website: string,
	username: string,
	market: string,
	merged: { telegram: boolean; linktree: boolean; panelz: boolean },
	content: string,
): Promise<void> {
	const w = String(website ?? "").trim().toUpperCase();
	await getTurso(env).prepare(
		`INSERT INTO sent_registry
		   (hash, website, sent_at, username, market, telegram, linktree, panelz, content)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(hash, website) DO UPDATE SET
		   sent_at = excluded.sent_at,
		   username = excluded.username,
		   market = excluded.market,
		   telegram = excluded.telegram,
		   linktree = excluded.linktree,
		   panelz = excluded.panelz,
		   content = excluded.content`,
	)
		.bind(
			hash,
			w,
			tsNow(),
			username || "",
			market || "-",
			merged.telegram ? 1 : 0,
			merged.linktree ? 1 : 0,
			merged.panelz ? 1 : 0,
			content || "",
		)
		.run();
}
