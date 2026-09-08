// Secret yang di-set via `wrangler secret put` (tidak muncul di wrangler.jsonc,
// jadi tidak ikut ter-generate oleh `wrangler types`).
interface Env {
	/** Fine-grained GitHub PAT, akses repo daygroup-scraper, Actions: read/write. */
	GH_TOKEN?: string;
}
