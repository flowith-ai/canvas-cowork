#!/usr/bin/env node
/**
 * `npx -y github:flowith-ai/canvas-cowork <command>`: the CLI from anywhere, on Node 22.18+ or Bun.
 *
 * Node runs the TypeScript sources as they are (type stripping), but never inside node_modules, which is
 * where npx puts this package. So the .ts files of this package are stripped here, with Node's own
 * stripper, before Node loads them. Bun runs TypeScript natively and skips all of this.
 */
import module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL("../scripts/index.ts", import.meta.url);

if (!process.versions.bun) {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 18) || typeof module.registerHooks !== "function" || typeof module.stripTypeScriptTypes !== "function") {
		process.stderr.write(`canvas-cowork needs Node 22.18 or later (this is ${process.version}), or Bun 1.1+.\n`);
		process.exit(1);
	}
	const root = new URL("../", import.meta.url).href;
	module.registerHooks({
		load(url, context, nextLoad) {
			if (!url.startsWith(root) || !url.endsWith(".ts")) return nextLoad(url, context);
			const source = module.stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"));
			return { format: "module", source, shortCircuit: true };
		},
	});
}

await import(entry.href);
