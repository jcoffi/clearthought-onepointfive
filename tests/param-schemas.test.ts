/**
 * Per-operation parameter schemas.
 *
 * Contract (derived from ~360 recorded real calls):
 *  - unknown keys are ignored (models send many keys the handlers never read)
 *  - snake_case / spaced variants of a known key are accepted as aliases
 *  - unambiguous coercions: lone item -> one-item list, "5" -> 5, "true" -> true,
 *    null -> absent
 *  - anything else wrong is rejected with a field-level message, as a returned
 *    error result (never a thrown exception)
 *  - echo-only fields are not validated, so calls that worked keep working
 */

import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "../src/config.js";
import { SessionState } from "../src/state/SessionState.js";
import {
	ClearThoughtParamsSchema,
	executeClearThoughtOperation,
	handleClearThoughtTool,
} from "../src/tools/index.js";
import {
	EXEMPT_OPERATIONS,
	hasParamSchema,
	validateParameters,
} from "../src/tools/paramSchemas.js";

const ok = (op: string, params: Record<string, unknown>) => {
	const r = validateParameters(op, params);
	if (!r.ok) throw new Error(`expected ok, got: ${r.issues.join(" | ")}`);
	return r.data as Record<string, any>;
};
const bad = (op: string, params: Record<string, unknown>) => {
	const r = validateParameters(op, params);
	if (r.ok) throw new Error("expected validation failure");
	return r.issues;
};

describe("unknown keys and aliases", () => {
	it("passes unknown keys through untouched", () => {
		const d = ok("decision_framework", {
			framework: "weighted_criteria",
			frameworkType: "x",
			options: ["a"],
		});
		expect(d.framework).toBe("weighted_criteria");
		expect(d.frameworkType).toBe("x");
	});

	it("accepts snake_case aliases of known keys", () => {
		const d = ok("sequential_thinking", {
			thought_number: 2,
			total_thoughts: 5,
			next_thought_needed: true,
		});
		expect(d.thoughtNumber).toBe(2);
		expect(d.totalThoughts).toBe(5);
		expect(d.nextThoughtNeeded).toBe(true);
	});

	it("accepts a spaced variant such as 'total Thoughts'", () => {
		expect(ok("sequential_thinking", { "total Thoughts": 4 }).totalThoughts).toBe(4);
	});

	it("the canonical camelCase key wins over an alias", () => {
		const d = ok("sequential_thinking", { thoughtNumber: 1, thought_number: 9 });
		expect(d.thoughtNumber).toBe(1);
	});

	it("does not alias keys that are not in the operation's schema", () => {
		const d = ok("decision_framework", { thought_number: 3 });
		expect(d.thoughtNumber).toBeUndefined();
		expect(d.thought_number).toBe(3);
	});
});

describe("unambiguous coercions", () => {
	it("a lone string becomes a one-item string list", () => {
		expect(ok("socratic_method", { premises: "all men are mortal" }).premises).toEqual([
			"all men are mortal",
		]);
	});

	it("a lone string option/criterion stays a string and is wrapped", () => {
		const d = ok("decision_framework", { options: "sqlite", criteria: ["speed", { name: "cost" }] });
		expect(d.options).toEqual(["sqlite"]);
		expect(d.criteria).toEqual(["speed", { name: "cost" }]);
	});

	it("a lone object becomes a one-item object list", () => {
		const rel = { from: "a", to: "b" };
		expect(ok("systems_thinking", { relationships: rel }).relationships).toEqual([rel]);
	});

	it("numeric strings become numbers", () => {
		const d = ok("simulation", { steps: "5" });
		expect(d.steps).toBe(5);
	});

	it("'true'/'false' become booleans", () => {
		expect(ok("ooda_loop", { autoAdvance: "false" }).autoAdvance).toBe(false);
		expect(ok("ooda_loop", { includeExport: "TRUE" }).includeExport).toBe(true);
	});

	it("null means absent", () => {
		const d = ok("ooda_loop", { evidence: null, hypotheses: null, autoAdvance: null });
		expect(d.evidence).toBeUndefined();
		expect(d.autoAdvance).toBeUndefined();
	});

	it("leaves valid structures unchanged", () => {
		const graph = { nodes: ["a", "b"], edges: [{ from: "a", to: "b", weight: 1 }] };
		expect(ok("causal_analysis", { graph }).graph).toEqual(graph);
	});
});

describe("field-level errors", () => {
	it("rejects a string graph and names the field and expected shape", () => {
		const issues = bad("causal_analysis", { graph: "cache -> latency" });
		expect(issues).toHaveLength(1);
		expect(issues[0]).toContain("parameters.graph");
		expect(issues[0]).toContain("expected");
		expect(issues[0]).toContain("object");
		expect(issues[0]).toContain("string");
	});

	it("points at the offending list index", () => {
		const issues = bad("systems_thinking", {
			relationships: [{ from: "a", to: "b" }, null],
		});
		expect(issues[0]).toContain("parameters.relationships[1]");
		expect(issues[0]).toContain("null");
	});

	it("reports every problem at once, not just the first", () => {
		const issues = bad("simulation", { steps: "many", initial: "x", updateRules: 7 });
		expect(issues.length).toBe(3);
		expect(issues.join(" ")).toContain("parameters.steps");
		expect(issues.join(" ")).toContain("parameters.initial");
		expect(issues.join(" ")).toContain("parameters.updateRules");
	});

	it("rejects non-numeric strings and non-finite numbers where a number is needed", () => {
		expect(bad("optimization", { iterations: "lots" })[0]).toContain("parameters.iterations");
		expect(bad("optimization", { iterations: Number.NaN })[0]).toContain("parameters.iterations");
	});

	it("reports nested graph problems with a path", () => {
		const issues = bad("causal_analysis", { graph: { nodes: [1], edges: ["x"] } });
		expect(issues.join(" ")).toContain("parameters.graph.nodes[0]");
		expect(issues.join(" ")).toContain("parameters.graph.edges[0]");
	});

	it("rejects a record value of the wrong type with its key in the path", () => {
		expect(bad("statistical_reasoning", { prior: { true: "a lot" } })[0]).toContain(
			"parameters.prior.true",
		);
		expect(bad("optimization", { variables: { x: null } })[0]).toContain("parameters.variables.x");
	});
});

describe("graph nodes and soft fields", () => {
	it("accepts object nodes (real callers send {id, label})", () => {
		const graph = { nodes: [{ id: "a", label: "A" }, "b"], edges: [] };
		expect(ok("causal_analysis", { graph }).graph).toEqual(graph);
	});

	it("a free-text intervention is accepted but reported in warnings and ignored", () => {
		const r = validateParameters("causal_analysis", { intervention: "Adding the cache layer" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.data.intervention).toBeUndefined();
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("parameters.intervention");
		expect(r.warnings[0]).toContain("ignored");
	});

	it("a valid intervention produces no warning", () => {
		const r = validateParameters("causal_analysis", { intervention: { variable: "x", delta: 1 } });
		expect(r.ok && r.warnings).toEqual([]);
	});

	it("warnings do not leak between validations", () => {
		validateParameters("causal_analysis", { intervention: "text" });
		const r = validateParameters("causal_analysis", {});
		expect(r.ok && r.warnings).toEqual([]);
	});
});

describe("fields that are only echoed are never validated", () => {
	it("structured_argumentation accepts any shapes (nothing is computed from them)", () => {
		const weird = {
			premises: 5,
			confidence: "high",
			supports: { a: 1 },
			strengths: null,
			respondsTo: [],
		};
		expect(validateParameters("structured_argumentation", weird).ok).toBe(true);
	});

	it("echo-only strings are not type-checked", () => {
		expect(validateParameters("decision_framework", { analysisType: 5 }).ok).toBe(true);
	});
});

describe("coverage", () => {
	it("every operation has a schema or is explicitly exempt", () => {
		const ops = ClearThoughtParamsSchema.shape.operation.options as string[];
		const missing = ops.filter((o) => !hasParamSchema(o) && !EXEMPT_OPERATIONS.has(o));
		expect(missing).toEqual([]);
	});

	it("exempt operations really are not validated", () => {
		for (const op of EXEMPT_OPERATIONS) {
			expect(validateParameters(op, { anything: [1, null, "x"] }).ok).toBe(true);
		}
	});

	it("unknown operations are not rejected here (the enum handles that)", () => {
		expect(validateParameters("no_such_op", { a: 1 }).ok).toBe(true);
	});
});

describe("integration with the tool", () => {
	const fresh = () => new SessionState("ps", ServerConfigSchema.parse({}));

	it("returns a structured error result instead of throwing", async () => {
		const out = (await executeClearThoughtOperation(fresh(), "systems_thinking", {
			prompt: "x",
			parameters: { relationships: "a->b" },
		})) as Record<string, any>;
		expect(out.success).toBe(false);
		expect(out.toolOperation).toBe("systems_thinking");
		expect(out.error).toContain("Invalid parameters");
		expect(out.issues[0]).toContain("parameters.relationships");
		expect(typeof out.hint).toBe("string");
	});

	it("marks the MCP response as an error", async () => {
		const res = await handleClearThoughtTool(fresh(), {
			operation: "causal_analysis",
			prompt: "cache layer increases latency",
			parameters: { graph: "cache -> latency" },
			advanced: { saveToSession: true, generateNextSteps: true },
		} as any);
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("parameters.graph");
	});

	it("surfaces warnings on a successful result", async () => {
		const out = (await executeClearThoughtOperation(fresh(), "causal_analysis", {
			prompt: "cache layer increases latency",
			parameters: { intervention: "Adding the cache layer" },
		})) as Record<string, any>;
		expect(out.success).not.toBe(false);
		expect(out.warnings[0]).toContain("parameters.intervention");
		expect(out.graph.nodes.length).toBeGreaterThan(0);
	});

	it("accepted aliases are honoured by the handler", async () => {
		const out = (await executeClearThoughtOperation(fresh(), "sequential_thinking", {
			prompt: "plan",
			parameters: { thought_number: 3, total_thoughts: 7 },
		})) as Record<string, any>;
		expect(out.thoughtNumber).toBe(3);
		expect(out.totalThoughts).toBe(7);
	});

	it("valid calls are unaffected", async () => {
		const out = (await executeClearThoughtOperation(fresh(), "decision_framework", {
			prompt: "choose",
			parameters: {
				options: [
					{ name: "a", attributes: { speed: 3 } },
					{ name: "b", attributes: { speed: 5 } },
				],
				criteria: [{ name: "speed", weight: 1 }],
			},
		})) as Record<string, any>;
		expect(out.success).not.toBe(false);
		expect(out.recommendation).toBe("b");
	});

	it("string options/criteria are still echoed unchanged", async () => {
		const out = (await executeClearThoughtOperation(fresh(), "decision_framework", {
			prompt: "choose",
			parameters: { options: ["a", "b"], criteria: ["speed", "cost"] },
		})) as Record<string, any>;
		expect(out.options).toEqual(["a", "b"]);
		expect(out.criteria).toEqual(["speed", "cost"]);
	});
});
