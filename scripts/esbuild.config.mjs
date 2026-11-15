import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const banner = `/*
Plugin Obsidian "Text Machine". Build généré, ne pas éditer directement.
*/`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["plugin/main.ts"],
	bundle: true,
	external: [
        "node:*",
		"obsidian",
		"electron",
        "@electron/remote",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
	],
	format: "cjs",
	target: "es2018",
	supported: { "dynamic-import": false },
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	loader: { ".md": "text", ".dat": "text", ".svg": "text" },

});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
