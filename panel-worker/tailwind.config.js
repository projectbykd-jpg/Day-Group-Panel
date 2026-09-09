/**
 * Build Tailwind sekali saat deploy (scripts/build-ui.mjs) jadi CSS statis
 * yang di-inline ke public/index.html — menggantikan Play CDN
 * (cdn.tailwindcss.com) yang meng-compile CSS di browser tiap DOM berubah
 * (MutationObserver) sehingga panel berat & lag di Chrome.
 */
module.exports = {
	content: ["./ui-src/**/*.html"],
	// Kelas yang dibangun lewat string di Scripts.html (ternary/interpolasi) —
	// aman-kan supaya tidak ke-purge.
	safelist: [
		// warna yang dipilih lewat argumen string (lapStatCard, selisih koin, dst)
		{
			pattern:
				/^(text|bg|border|from|to|via)-(slate|gray|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal)-(200|300|400|500|600|700)$/,
		},
		{ pattern: /^grid-cols-(1|2|3|4|5|6)$/ },
	],
	theme: { extend: {} },
	plugins: [],
};
