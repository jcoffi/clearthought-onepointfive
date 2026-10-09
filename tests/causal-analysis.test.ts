/**
 * causal_analysis: malformed `graph` / `intervention` parameters must be
 * tolerated, not crash the handler ("Cannot read properties of undefined
 * (reading 'length')").
 */

import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "../src/config.js";
import { SessionState } from "../src/state/SessionState.js";
import { executeClearThoughtOperation } from "../src/tools/index.js";

const run = (prompt: string, parameters: Record<string, unknown>) =>
	executeClearThoughtOperation(
		new SessionState("causal-test", ServerConfigSchema.parse({})),
		"causal_analysis",
		{ prompt, parameters },
	) as Promise<Record<string, any>>;

describe("causal_analysis parameter handling", () => {
	it("uses a well-formed graph object and applies the intervention", async () => {
		const out = await run("cache layer increases latency", {
			graph: {
				nodes: ["cache", "latency"],
				edges: [{ from: "cache", to: "latency", weight: 1 }],
			},
			intervention: { variable: "cache", delta: 1 },
		});
		expect(out.success).not.toBe(false);
		expect(out.graph.nodes).toEqual(["cache", "latency"]);
		expect(out.predictedEffects).toEqual({ latency: 1 });
	});

	it("extracts a graph from the prompt when graph is omitted", async () => {
		const out = await run("cache layer increases latency", {});
		expect(out.graph.nodes.length).toBeGreaterThan(0);
	});

	it("rejects a string graph with a clear field-level error instead of crashing", async () => {
		const out = await run("cache layer increases latency", {
			graph: "cache -> latency",
		});
		expect(out.success).toBe(false);
		expect(out.issues[0]).toContain("parameters.graph");
		expect(out.issues[0]).toContain("object");
	});

	it("does not crash when graph lacks nodes/edges arrays", async () => {
		const out = await run("cache layer increases latency", {
			graph: { nodes: "cache", edges: null },
		});
		expect(out.error).toBeUndefined();
		expect(Array.isArray(out.graph.nodes)).toBe(true);
		expect(Array.isArray(out.graph.edges)).toBe(true);
	});

	it("keeps nodes when edges is missing", async () => {
		const out = await run("irrelevant", { graph: { nodes: ["a", "b"] } });
		expect(out.error).toBeUndefined();
		expect(out.graph.nodes).toEqual(["a", "b"]);
		expect(out.graph.edges).toEqual([]);
	});

	it("accepts a free-text intervention, ignores it, and says so in warnings", async () => {
		const out = await run("cache layer increases latency", {
			graph: {
				nodes: ["cache", "latency"],
				edges: [{ from: "cache", to: "latency" }],
			},
			intervention: "cache",
		});
		expect(out.success).not.toBe(false);
		expect(out.predictedEffects).toBeUndefined();
		expect(out.warnings[0]).toContain("parameters.intervention");
	});
});
