/**
 * decision_framework regression tests.
 *
 * Real callers (checked against ~360 recorded clear_thought calls) very often
 * send `options` and `criteria` as plain string lists. Those must be echoed
 * back, never silently dropped, and must not produce bogus "undefined" scores.
 */

import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "../src/config.js";
import { SessionState } from "../src/state/SessionState.js";
import { executeClearThoughtOperation } from "../src/tools/index.js";

const run = (parameters: Record<string, unknown>) =>
	executeClearThoughtOperation(
		new SessionState("df-test", ServerConfigSchema.parse({})),
		"decision_framework",
		{ prompt: "choose a database", parameters },
	) as Promise<Record<string, any>>;

describe("decision_framework with string options/criteria", () => {
	it("echoes string criteria instead of dropping them", async () => {
		const out = await run({ criteria: ["speed", "cost"] });
		expect(out.criteria).toEqual(["speed", "cost"]);
	});

	it("echoes string options", async () => {
		const out = await run({ options: ["sqlite", "postgres"] });
		expect(out.options).toEqual(["sqlite", "postgres"]);
	});

	it("does not invent an 'undefined' score or recommendation from names only", async () => {
		const out = await run({
			options: ["sqlite", "postgres"],
			criteria: ["speed", "cost"],
		});
		expect(JSON.stringify(out)).not.toContain("undefined");
		// Same empty (but present) shape callers got before, minus the bogus key.
		expect(out.multiCriteriaScores).toEqual({});
		expect(out.recommendation).toBe("");
		expect(out.suggestedNextStage).toBe("gather-more-data");
	});

	it("drops null entries but keeps the valid ones", async () => {
		const out = await run({ criteria: [null, "speed", 5, { name: "cost" }] });
		expect(out.criteria).toEqual(["speed", { name: "cost" }]);
	});
});

describe("decision_framework with object options/criteria", () => {
	it("still scores object options and recommends the best one", async () => {
		const out = await run({
			options: [
				{ name: "a", attributes: { speed: 3 } },
				{ name: "b", attributes: { speed: 5 } },
			],
			criteria: [{ name: "speed", weight: 1 }],
		});
		expect(out.multiCriteriaScores).toEqual({ a: 3, b: 5 });
		expect(out.recommendation).toBe("b");
		expect(out.suggestedNextStage).toBe("implementation");
	});

	it("scores object options even when some entries are plain strings", async () => {
		const out = await run({
			options: ["note", { name: "b", attributes: { speed: 5 } }],
			criteria: [{ name: "speed" }],
		});
		expect(out.multiCriteriaScores).toEqual({ b: 5 });
	});

	it("does not throw for mixed wrong-typed options and criteria", async () => {
		await expect(
			run({ options: "abc", criteria: [{ name: "speed" }] }),
		).resolves.toBeDefined();
		await expect(
			run({ options: [{ name: "a" }], criteria: "abc" }),
		).resolves.toBeDefined();
	});

	it("expected-utility ignores malformed outcomes and options", async () => {
		const out = await run({
			analysisType: "expected-utility",
			options: [{ name: "a" }, "stray", null],
			possibleOutcomes: [
				{ option: "a", probability: 0.5, value: 10 },
				null,
				"bad",
			],
		});
		expect(out.expectedValues).toEqual({ a: 5 });
		expect(out.recommendation).toBe("a");
	});
});
