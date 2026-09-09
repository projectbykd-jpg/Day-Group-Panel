/**
 * Build Tailwind sekali saat deploy (scripts/build-ui.mjs) jadi CSS statis
 * yang di-inline ke public/index.html — menggantikan Play CDN
 * (cdn.tailwindcss.com) yang meng-compile CSS di browser tiap DOM berubah
 * (MutationObserver) sehingga panel berat & lag di Chrome.
 */
module.exports = {
	content: ["./ui-src/**/*.html"],
	// Semua kelas warna di ui-src/*.html sudah string literal (ternary, bukan
	// "'text-'+var") jadi ke-scan otomatis oleh `content`. Safelist dikecilkan
	// -> CSS jauh lebih kecil (~43KB vs ~107KB).
	safelist: [
		{ pattern: /^(sm:|md:|lg:|xl:)?grid-cols-([1-9]|1[0-2])$/ },
	],
	theme: { extend: {} },
	plugins: [],
};
