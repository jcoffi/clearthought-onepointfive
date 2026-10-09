/**
 * The `parameters` bag is untyped (z.record(z.unknown())), so a model can send
 * any shape for any key. No operation may throw because of that.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "../src/config.js";
import { SessionState } from "../src/state/SessionState.js";
import {
	ClearThoughtParamsSchema,
	executeClearThoughtOperation,
} from "../src/tools/index.js";

const source = readFileSync(
	fileURLToPath(new URL("../src/tools/index.ts", import.meta.url)),
	"utf8",
);
const keys = [
	...new Set([
		...[...source.matchAll(/parameters\.(\w+)/g)].map((m) => m[1]),
		...[...source.matchAll(/getParam\(\s*"(\w+)"/g)].map((m) => m[1]),
		...[...source.matchAll(/\(parameters as any\)\.(\w+)/g)].map((m) => m[1]),
	]),
].filter((k) => k !== "length");

// Skipped: spawn python / need a prior notebook / import arbitrary state.
const SKIP = new Set(["code_execution", "notebook_run_cell", "session_import"]);
const ops = (ClearThoughtParamsSchema.shape.operation.options as string[]).filter(
	(o) => !SKIP.has(o),
);

const values: Record<string, unknown> = {
	str: "abc",
	emptyStr: "",
	num: 5,
	negNum: -1,
	bool: true,
	obj: {},
	arr: [],
	nul: null,
	strArr: ["a", "b"],
	numArr: [1, 2],
	nullArr: [null],
	objArr: [{}],
	nestedArr: [[1]],
	objStr: { nodes: "x", edges: "y" },
};

const fresh = () => new SessionState("ts", ServerConfigSchema.parse({}));
const run = (op: string, parameters: Record<string, unknown>) =>
	executeClearThoughtOperation(fresh(), op, {
		prompt: "cache layer increases latency",
		parameters,
	}) as Promise<Record<string, any>>;

describe("wrong-typed parameters never throw", () => {
	it("covers every operation and a non-trivial set of parameter keys", () => {
		expect(ops.length).toBeGreaterThan(30);
		expect(keys.length).toBeGreaterThan(100);
	});

	it("single wrong-typed parameter, every operation x key x value", async () => {
		const failures: string[] = [];
		for (const op of ops) {
			for (const key of keys) {
				for (const [vn, v] of Object.entries(values)) {
					try {
						await run(op, { [key]: v });
					} catch (e: any) {
						failures.push(`${op}.${key}=${vn}: ${e?.message}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	}, 120000);
});

describe("many wrong-typed parameters at once never throw", () => {
	it("every key set to the same wrong-typed value, per operation", async () => {
		const failures: string[] = [];
		const shapes: unknown[] = [
			"abc", 5, true, {}, [], null, ["a"], [1], [null], [{}], [[1]],
			{ nodes: "x", edges: "y" }, { a: { b: "c" } },
		];
		for (const op of ops) {
			for (const v of shapes) {
				const parameters = Object.fromEntries(keys.map((k) => [k, v]));
				try {
					await run(op, parameters);
				} catch (e: any) {
					failures.push(`${op} all=${JSON.stringify(v)}: ${e?.message}`);
				}
			}
		}
		expect(failures).toEqual([]);
	}, 120000);
});

describe("lenient coercion keeps usable input", () => {
	it("analogical_reasoning: non-string domains fall back to prompt extraction", async () => {
		const out = await run("analogical_reasoning", {
			sourceDomain: 5,
			targetDomain: { x: 1 },
		});
		expect(typeof out.sourceDomain).toBe("string");
		expect(typeof out.targetDomain).toBe("string");
	});

	it("socratic_method: a lone string premise is kept as one premise", async () => {
		const out = await run("socratic_method", { premises: "all men are mortal" });
		expect(JSON.stringify(out)).toContain("all men are mortal");
	});

	it("creative_thinking: a lone string idea is kept", async () => {
		const out = await run("creative_thinking", { ideas: "use a cache" });
		expect(out.ideas).toContain("use a cache");
	});

	it("ooda_loop: a lone string evidence item is counted as evidence", async () => {
		const none = await run("ooda_loop", {});
		const one = await run("ooda_loop", { evidence: "p99 doubled" });
		expect(one.metrics.evidenceQuality).toBeGreaterThan(
			none.metrics.evidenceQuality,
		);
	});

	it("systems_thinking: null relationship entries are ignored, valid ones used", async () => {
		const out = await run("systems_thinking", {
			relationships: [null, { from: "a", to: "b", type: "causes" }],
		});
		expect(out.relationships).toEqual([{ from: "a", to: "b", type: "causes" }]);
	});

	it("decision_framework: null criteria entries are ignored", async () => {
		const out = await run("decision_framework", {
			options: [{ name: "x", scores: {} }],
			criteria: [null, { name: "speed", weight: 2 }],
		});
		expect(out.criteria).toEqual([{ name: "speed", weight: 2 }]);
	});

	it("statistical_reasoning: non-array data is treated as empty", async () => {
		const out = await run("statistical_reasoning", { data: "1,2,3" });
		expect(out.stats.n).toBe(0);
	});

	it("sequential_thinking: non-object patternParams is ignored", async () => {
		const out = await run("sequential_thinking", { patternParams: "deep" });
		expect(out.selectedPattern).toBe("chain");
	});
});
