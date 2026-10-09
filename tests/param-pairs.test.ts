/**
 * Pairwise fuzz: for every operation, set each PAIR of the parameter keys that
 * operation actually reads to each PAIR of wrong-typed values. Single-key fuzzing
 * misses crashes that need one valid-looking value plus one wrong-typed value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ServerConfigSchema } from "../src/config.js";
import { SessionState } from "../src/state/SessionState.js";
import { executeClearThoughtOperation } from "../src/tools/index.js";

const source = readFileSync(
	fileURLToPath(new URL("../src/tools/index.ts", import.meta.url)),
	"utf8",
);
const body = source.slice(
	source.indexOf("export async function executeClearThoughtOperation"),
);
const blocks = body.split(/\n\t\tcase "([a-z_]+)": \{/);
const keysByOp = new Map<string, string[]>();
for (let i = 1; i < blocks.length; i += 2) {
	const text = blocks[i + 1] ?? "";
	const keys = new Set<string>([
		...[...text.matchAll(/parameters\.(\w+)/g)].map((m) => m[1]),
		...[...text.matchAll(/getParam\(\s*"(\w+)"/g)].map((m) => m[1]),
		...[...text.matchAll(/\(parameters as any\)\.(\w+)/g)].map((m) => m[1]),
	]);
	keys.delete("length");
	keysByOp.set(blocks[i], [...keysByOp.get(blocks[i]) ?? [], ...keys]);
}

const SKIP = new Set(["code_execution", "notebook_run_cell", "session_import"]);
const values: unknown[] = [
	"abc", 5, true, {}, [], null, ["a"], [1], [null], [{}],
	[{ name: "x", attributes: { speed: 1 } }], { nodes: "x", edges: "y" },
];

it("discovers keys for most operations", () => {
	expect(keysByOp.size).toBeGreaterThan(25);
});

it("no operation throws for any pair of wrong-typed parameters", async () => {
	const failures: string[] = [];
	for (const [op, keys] of keysByOp) {
		if (SKIP.has(op)) continue;
		const uniq = [...new Set(keys)];
		for (let a = 0; a < uniq.length; a++) {
			for (let b = a + 1; b < uniq.length; b++) {
				for (const va of values) {
					for (const vb of values) {
						try {
							await executeClearThoughtOperation(
								new SessionState("pp", ServerConfigSchema.parse({})),
								op,
								{
									prompt: "cache layer increases latency",
									parameters: { [uniq[a]]: va, [uniq[b]]: vb },
								},
							);
						} catch (e: any) {
							failures.push(
								`${op}: ${uniq[a]}=${JSON.stringify(va)} ${uniq[b]}=${JSON.stringify(vb)} -> ${e?.message}`,
							);
						}
					}
				}
			}
		}
	}
	// Report distinct (operation, message) pairs, not thousands of repeats.
	const distinct = [...new Set(failures.map((f) => f.split(" -> ")[0].split(":")[0] + " -> " + f.split(" -> ")[1]))];
	expect(distinct).toEqual([]);
}, 280000);
