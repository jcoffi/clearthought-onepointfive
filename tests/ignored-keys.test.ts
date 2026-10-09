/**
 * Ignored parameters are reported, and content models commonly send is used.
 *
 * Background: in recorded real use, ~30% of the keys models sent were read by no
 * handler and were dropped silently, including the actual text of
 * sequential_thinking thoughts and the OODA phase texts.
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
import {
	EXEMPT_OPERATIONS,
	paramKeysFor,
	validateParameters,
} from "../src/tools/paramSchemas.js";

const fresh = () => new SessionState("ik", ServerConfigSchema.parse({}));
const run = (op: string, parameters: Record<string, unknown>, prompt = "p") =>
	executeClearThoughtOperation(fresh(), op, { prompt, parameters }) as Promise<
		Record<string, any>
	>;

describe("ignored-key warning", () => {
	it("names every ignored key and lists what the operation reads", () => {
		const r = validateParameters("sequential_thinking", {
			thoughtNumber: 1,
			framework: "x",
			note: "y",
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings).toHaveLength(1);
		const w = r.warnings[0];
		expect(w).toContain("parameters.framework");
		expect(w).toContain("parameters.note");
		expect(w).toContain("not read by sequential_thinking");
		expect(w).toContain("thoughtNumber");
		expect(w).not.toContain("parameters.thoughtNumber");
	});

	it("does not flag known keys, snake_case aliases or internal __ keys", () => {
		const r = validateParameters("sequential_thinking", {
			thoughtNumber: 1,
			total_thoughts: 3,
			"next Thought Needed": true,
			__disablePatternDispatch: true,
		});
		expect(r.ok && r.warnings).toEqual([]);
	});

	it("does not flag keys that are only echoed", () => {
		const r = validateParameters("structured_argumentation", {
			premises: ["a"],
			conclusion: "c",
			confidence: 0.4,
		});
		expect(r.ok && r.warnings).toEqual([]);
	});

	it("exempt operations never warn", () => {
		for (const op of EXEMPT_OPERATIONS) {
			const r = validateParameters(op, { whatever: 1 });
			expect(r.ok && r.warnings).toEqual([]);
		}
	});

	it("reaches the caller on a successful result", async () => {
		const out = await run("decision_framework", {
			options: ["a", "b"],
			framework: "weighted",
		});
		expect(out.success).not.toBe(false);
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings[0]).toContain("parameters.framework");
	});

	it("is absent when nothing was ignored", async () => {
		const out = await run("decision_framework", { options: ["a", "b"] });
		expect(out.warnings).toBeUndefined();
	});

	it("is not duplicated through pdr_reasoning's internal call", async () => {
		const out = await run("pdr_reasoning", { extra: 1 });
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings[0]).toContain("not read by pdr_reasoning");
	});
});

describe("sequential_thinking honours `thought`", () => {
	it("records the thought text instead of the prompt", async () => {
		const out = await run(
			"sequential_thinking",
			{ thought: "Step 1: map the schema", thoughtNumber: 1 },
			"Plan migration step 1",
		);
		expect(out.thought).toBe("Step 1: map the schema");
		expect(out.warnings).toBeUndefined();
	});

	it("falls back to the prompt when thought is absent or blank", async () => {
		expect((await run("sequential_thinking", {}, "the prompt")).thought).toBe("the prompt");
		expect((await run("sequential_thinking", { thought: "   " }, "the prompt")).thought).toBe(
			"the prompt",
		);
	});

	it("ignores a non-string thought with a warning instead of rejecting the call", async () => {
		const out = await run("sequential_thinking", { thought: { a: 1 } }, "the prompt");
		expect(out.success).not.toBe(false);
		expect(out.thought).toBe("the prompt");
		expect(out.warnings[0]).toContain("parameters.thought");
		expect(out.warnings[0]).toContain("ignored");
	});

	it("the pdr_reasoning variant uses it too", async () => {
		const out = await run("pdr_reasoning", { thought: "deep thought" }, "p");
		expect(out.thought).toBe("deep thought");
	});
});

describe("ooda_loop records the phase texts it is given", () => {
	const texts = {
		observe: "Observed: p99 15ms -> 45ms after ingest doubled",
		orient: "Oriented: hot shard and compaction overlap",
		decide: "Decided: throttle compaction during peaks",
		act: "Act: deployed compaction window",
	};
	const exportOf = (out: Record<string, any>) => String(out.export);

	it("records every provided phase as a node of its own phase, in OODA order", async () => {
		const out = await run("ooda_loop", { ...texts, includeExport: true });
		expect(out.recordedPhases).toEqual(["observe", "orient", "decide", "act"]);
		const md = exportOf(out);
		for (const [phase, text] of Object.entries(texts)) {
			expect(md).toContain(text);
			expect(md).toContain(`#### ${phase.toUpperCase()}`);
		}
		expect(md.indexOf(texts.observe)).toBeLessThan(md.indexOf(texts.orient));
		expect(md.indexOf(texts.decide)).toBeLessThan(md.indexOf(texts.act));
		expect(out.warnings).toBeUndefined();
	});

	it("uses the current phase text as that node's content instead of the prompt", async () => {
		const out = await run("ooda_loop", { observe: texts.observe, includeExport: true }, "PROMPT-TEXT");
		expect(exportOf(out)).toContain(texts.observe);
		expect(exportOf(out)).not.toContain("PROMPT-TEXT");
	});

	it("still records the prompt as the current phase when no phase text is given", async () => {
		const out = await run("ooda_loop", { includeExport: true }, "PROMPT-TEXT");
		expect(exportOf(out)).toContain("PROMPT-TEXT");
		expect(out.recordedPhases).toEqual(["observe"]);
	});

	it("evidence, quality and auto-advance still apply to the current phase only", async () => {
		const out = await run("ooda_loop", {
			...texts,
			evidence: ["p99 rose from 15 to 45", "compaction overlap"],
		});
		expect(out.currentPhase).toBe("orient");
		expect(out.metrics.evidenceQuality).toBeGreaterThan(0);
	});

	it("ignores a non-string phase text with a warning", async () => {
		const out = await run("ooda_loop", { observe: 5, includeExport: true }, "PROMPT-TEXT");
		expect(out.success).not.toBe(false);
		expect(out.warnings[0]).toContain("parameters.observe");
		expect(exportOf(out)).toContain("PROMPT-TEXT");
	});

	it("accepts sessionId and the other read keys without an ignored-key warning", async () => {
		const out = await run("ooda_loop", { sessionId: "s1", autoAdvance: true, minEvidence: 2 });
		expect(out.warnings).toBeUndefined();
		const u = await run("ulysses_protocol", { sessionId: "u1", decisionRationale: "because" });
		expect(u.warnings).toBeUndefined();
	});
});

describe("schema covers every key a handler reads", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../src/tools/index.ts", import.meta.url)),
		"utf8",
	);
	const body = source.slice(source.indexOf("async function executeValidatedOperation"));
	const blocks = body.split(/\n\t\tcase "([a-z_]+)": \{/);

	it("finds the operation blocks", () => {
		expect((blocks.length - 1) / 2).toBeGreaterThan(30);
	});

	it("every key read by an operation's handler is declared in its schema", () => {
		const missing: string[] = [];
		for (let i = 1; i < blocks.length; i += 2) {
			const op = blocks[i];
			const text = blocks[i + 1] ?? "";
			const reads = new Set<string>([
				...[...text.matchAll(/parameters\.(\w+)/g)].map((m) => m[1]),
				...[...text.matchAll(/getParam\(\s*"(\w+)"/g)].map((m) => m[1]),
				...[...text.matchAll(/\(parameters as any\)\.(\w+)/g)].map((m) => m[1]),
			]);
			reads.delete("length");
			const keys = paramKeysFor(op);
			if (!keys) {
				if (reads.size > 0 && !EXEMPT_OPERATIONS.has(op)) missing.push(`${op}: no schema`);
				continue;
			}
			for (const k of reads) {
				if (!k.startsWith("__") && !keys.includes(k)) missing.push(`${op}.${k}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("covers every operation in the enum", () => {
		const ops = ClearThoughtParamsSchema.shape.operation.options as string[];
		expect(ops.filter((o) => !paramKeysFor(o) && !EXEMPT_OPERATIONS.has(o))).toEqual([]);
	});
});
