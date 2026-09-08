// Semua waktu panel = GMT+7 (Asia/Jakarta), disimpan apa adanya sebagai TEXT.
const OFFSET_MS = 7 * 60 * 60 * 1000;

/** "yyyy-MM-dd HH:mm:ss" di GMT+7 — sama persis dengan datetime('now','+7 hours') di D1. */
export function tsNow(): string {
	return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** "yyyy-MM-dd" di GMT+7. */
export function dateKeyNow(): string {
	return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
}

/** "yyyy-MM-dd HH:mm:ss" di GMT+7, N menit dari sekarang. */
export function tsPlusMinutes(minutes: number): string {
	return new Date(Date.now() + OFFSET_MS + minutes * 60 * 1000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}
