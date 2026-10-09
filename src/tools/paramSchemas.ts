/**
 * Per-operation validation for the untyped `parameters` bag of the unified
 * `clear_thought` tool.
 *
 * Design (derived from recorded real-world calls):
 *  - Unknown keys are ignored (passed through): models send many keys no handler
 *    reads (`framework`, `frameworkType`, ...).
 *  - snake_case / spaced / dashed variants of a *known* key are accepted as
 *    aliases (`thought_number` -> `thoughtNumber`). The canonical key wins.
 *  - Unambiguous coercions only: a lone item becomes a one-item list, numeric
 *    strings become numbers, "true"/"false" become booleans, null means absent.
 *  - Anything else wrong is rejected with a field-level message
 *    (`parameters.graph: expected an object {...}, got string "..."`), reported
 *    as a returned error result, never a thrown exception.
 *  - Harmless-but-unusable input (see `softObj`/`softStr`) is accepted and
 *    reported in a `warnings` list instead of being rejected, so flows that
 *    already worked keep working without the ignored value being silent.
 *  - Keys no handler reads are still passed through, but are listed in a
 *    `warnings` entry (with the keys the operation does read), so dropped input
 *    is never silent. Internal `__` keys and aliases are not reported.
 *  - Only fields a handler *computes with* are typed (lists it iterates, objects
 *    it indexes, numbers it does arithmetic on, booleans that gate logic).
 *    Echo-only fields are `any`, so calls that already worked keep working.
 *
 * When adding an operation, add a shape here (or list it in EXEMPT_OPERATIONS).
 */

import { z } from "zod";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);

const describeValue = (v: unknown): string => {
	if (v === null) return "null";
	if (Array.isArray(v)) return `array of ${v.length}`;
	if (typeof v === "string") {
		const s = v.length > 30 ? `${v.slice(0, 30)}...` : v;
		return `string ${JSON.stringify(s)}`;
	}
	if (typeof v === "number") return `number ${v}`;
	if (typeof v === "boolean") return `boolean ${v}`;
	if (typeof v === "object") return "object";
	return typeof v;
};

const toNumber = (v: unknown): number | undefined => {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
};

const toBool = (v: unknown): boolean | undefined => {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true") return true;
		if (s === "false") return false;
	}
	return undefined;
};

type Ctx = z.RefinementCtx;
type Path = Array<string | number>;
const INVALID = Symbol("invalid");

const addIssue = (ctx: Ctx, path: Path, message: string): void =>
	ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

// ---- list coercion ---------------------------------------------------------

type ElemKind = "string" | "object" | "stringOrObject" | "number";

const ELEM_NAME: Record<ElemKind, string> = {
	string: "string",
	object: "object",
	stringOrObject: "string or object",
	number: "number",
};
const LIST_NAME: Record<ElemKind, string> = {
	string: "an array of strings",
	object: "an array of objects",
	stringOrObject: "an array of strings or objects",
	number: "an array of numbers",
};

const coerceElem = (
	kind: ElemKind,
	x: unknown,
): { ok: true; value: unknown } | { ok: false } => {
	switch (kind) {
		case "string":
			return typeof x === "string" ? { ok: true, value: x } : { ok: false };
		case "object":
			return isPlainObject(x) ? { ok: true, value: x } : { ok: false };
		case "stringOrObject":
			return typeof x === "string" || isPlainObject(x)
				? { ok: true, value: x }
				: { ok: false };
		case "number": {
			const n = toNumber(x);
			return n === undefined ? { ok: false } : { ok: true, value: n };
		}
	}
};

const coerceList = (
	kind: ElemKind,
	v: unknown,
	ctx: Ctx,
	base: Path,
): unknown[] | undefined | typeof INVALID => {
	if (v === undefined || v === null) return undefined;
	if (Array.isArray(v)) {
		const out: unknown[] = [];
		let failed = false;
		v.forEach((x, i) => {
			const r = coerceElem(kind, x);
			if (r.ok) out.push(r.value);
			else {
				failed = true;
				addIssue(
					ctx,
					[...base, i],
					`expected ${ELEM_NAME[kind]}, got ${describeValue(x)}`,
				);
			}
		});
		return failed ? INVALID : out;
	}
	// A lone item stands for a one-item list; a lone blank string is an empty list.
	if (
		typeof v === "string" &&
		v.trim() === "" &&
		(kind === "string" || kind === "stringOrObject")
	) {
		return [];
	}
	const r = coerceElem(kind, v);
	if (r.ok) return [r.value];
	addIssue(ctx, base, `expected ${LIST_NAME[kind]}, got ${describeValue(v)}`);
	return INVALID;
};

// ---- field builders --------------------------------------------------------

const any = z.unknown();

const num = z.unknown().transform((v, ctx) => {
	if (v === undefined || v === null) return undefined;
	const n = toNumber(v);
	if (n === undefined) {
		addIssue(ctx, [], `expected a number, got ${describeValue(v)}`);
		return z.NEVER;
	}
	return n;
});

const bool = z.unknown().transform((v, ctx) => {
	if (v === undefined || v === null) return undefined;
	const b = toBool(v);
	if (b === undefined) {
		addIssue(ctx, [], `expected true or false, got ${describeValue(v)}`);
		return z.NEVER;
	}
	return b;
});

const str = z.unknown().transform((v, ctx) => {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") {
		addIssue(ctx, [], `expected a string, got ${describeValue(v)}`);
		return z.NEVER;
	}
	return v;
});

/** Warnings collected during the current (synchronous) validation pass. */
let activeWarnings: string[] | null = null;

/**
 * An object field that, when given something else, is *ignored with a warning*
 * rather than rejected. Used where real callers send free text for a field the
 * handler can only use as a structured object (it then simply does nothing).
 */
const softObj = (expected: string) =>
	z.unknown().transform((v, ctx) => {
		if (v === undefined || v === null) return undefined;
		if (!isPlainObject(v)) {
			activeWarnings?.push(
				`parameters.${formatPath(ctx.path as Path)}: expected ${expected}, got ${describeValue(v)}; ignored`,
			);
			return undefined;
		}
		return v;
	});

/** A string field that, when given something else, is ignored with a warning. */
const softStr = (expected: string) =>
	z.unknown().transform((v, ctx) => {
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string") {
			activeWarnings?.push(
				`parameters.${formatPath(ctx.path as Path)}: expected ${expected}, got ${describeValue(v)}; ignored`,
			);
			return undefined;
		}
		return v;
	});

const obj = z.unknown().transform((v, ctx) => {
	if (v === undefined || v === null) return undefined;
	if (!isPlainObject(v)) {
		addIssue(ctx, [], `expected an object, got ${describeValue(v)}`);
		return z.NEVER;
	}
	return v;
});

const list = (kind: ElemKind) =>
	z.unknown().transform((v, ctx) => {
		const r = coerceList(kind, v, ctx, []);
		return r === INVALID ? z.NEVER : r;
	});

const record = (kind: "number" | "object") =>
	z.unknown().transform((v, ctx) => {
		if (v === undefined || v === null) return undefined;
		if (!isPlainObject(v)) {
			addIssue(
				ctx,
				[],
				`expected an object mapping names to ${kind === "number" ? "numbers" : "objects"}, got ${describeValue(v)}`,
			);
			return z.NEVER;
		}
		const out: Record<string, unknown> = {};
		let failed = false;
		for (const [k, x] of Object.entries(v)) {
			if (kind === "number") {
				const n = toNumber(x);
				if (n === undefined) {
					failed = true;
					addIssue(ctx, [k], `expected a number, got ${describeValue(x)}`);
				} else out[k] = n;
			} else if (isPlainObject(x)) {
				out[k] = x;
			} else {
				failed = true;
				addIssue(ctx, [k], `expected an object, got ${describeValue(x)}`);
			}
		}
		return failed ? z.NEVER : out;
	});

const graph = z.unknown().transform((v, ctx) => {
	if (v === undefined || v === null) return undefined;
	if (!isPlainObject(v)) {
		addIssue(
			ctx,
			[],
			`expected an object {nodes: (string|object)[], edges: [{from, to, weight?}]}, got ${describeValue(v)}`,
		);
		return z.NEVER;
	}
	const out: Record<string, unknown> = { ...v };
	let failed = false;
	const parts: Array<[string, ElemKind]> = [
		["nodes", "stringOrObject"],
		["edges", "object"],
	];
	for (const [key, kind] of parts) {
		const r = coerceList(kind, v[key], ctx, [key]);
		if (r === INVALID) failed = true;
		else if (r === undefined) delete out[key];
		else out[key] = r;
	}
	return failed ? z.NEVER : out;
});

// ---- shapes ----------------------------------------------------------------

const thoughtFlow = {
	thoughtNumber: num,
	totalThoughts: num,
	nextThoughtNeeded: bool,
	needsMoreThoughts: bool,
	createNotebook: bool,
};

const sequentialThinkingShape = {
	thoughtNumber: num,
	totalThoughts: num,
	nextThoughtNeeded: bool,
	isRevision: bool,
	revisesThought: num,
	branchFromThought: num,
	needsMoreThoughts: bool,
	branchId: any,
	pattern: any,
	patternParams: obj,
	// Thought text (preferred over the prompt when it is a non-blank string).
	thought: softStr("a string"),
	// Internal: set by pattern operations to stop re-dispatching.
	__disablePatternDispatch: any,
};

const SHAPES: Record<string, Record<string, z.ZodTypeAny>> = {
	sequential_thinking: sequentialThinkingShape,
	// pdr_reasoning forwards its parameters to sequential_thinking unchanged.
	pdr_reasoning: sequentialThinkingShape,
	mental_model: { model: any, steps: any, reasoning: any, conclusion: any },
	debugging_approach: {
		approach: any,
		steps: any,
		findings: any,
		resolution: any,
	},
	creative_thinking: {
		ideas: list("string"),
		techniques: list("string"),
		connections: list("string"),
		insights: list("string"),
		numIdeas: num,
		iteration: num,
		nextIdeaNeeded: bool,
	},
	visual_reasoning: {
		diagramId: any,
		diagramType: any,
		iteration: num,
		nextOperationNeeded: bool,
	},
	metacognitive_monitoring: {
		stage: any,
		uncertaintyAreas: list("string"),
		overallConfidence: num,
		recommendedApproach: any,
		iteration: num,
	},
	scientific_method: { stage: any, iteration: num, nextStageNeeded: bool },
	collaborative_reasoning: {
		personas: list("object"),
		contributions: list("object"),
		stage: any,
	},
	decision_framework: {
		options: list("stringOrObject"),
		criteria: list("stringOrObject"),
		possibleOutcomes: list("object"),
		analysisType: any,
	},
	socratic_method: {
		claim: any,
		premises: list("string"),
		stage: any,
		conclusion: any,
		argumentType: any,
	},
	structured_argumentation: {
		premises: any,
		conclusion: any,
		argumentType: any,
		confidence: any,
		respondsTo: any,
		supports: any,
		contradicts: any,
		strengths: any,
		weaknesses: any,
		relevance: any,
		iteration: any,
		nextArgumentNeeded: any,
	},
	systems_thinking: {
		components: list("string"),
		relationships: list("object"),
		feedbackLoops: list("object"),
		emergentProperties: list("string"),
		leveragePoints: list("string"),
		iteration: num,
		nextAnalysisNeeded: bool,
	},
	research: {
		subqueries: list("string"),
		findings: list("object"),
		citations: list("object"),
	},
	analogical_reasoning: {
		sourceDomain: str,
		targetDomain: str,
		mappings: list("object"),
		inferredInsights: list("string"),
	},
	causal_analysis: {
		graph,
		intervention: softObj("an object {variable, setTo?, delta?}"),
		notes: list("string"),
	},
	statistical_reasoning: {
		mode: any,
		data: list("number"),
		prior: record("number"),
		likelihood: record("number"),
		effectSize: any,
		test: any,
		testStatistic: num,
		pValue: num,
		dof: num,
		samples: list("number"),
	},
	simulation: {
		steps: num,
		initial: record("number"),
		updateRules: list("object"),
	},
	optimization: {
		variables: record("object"),
		objective: str,
		iterations: num,
		method: any,
	},
	ethical_analysis: {
		framework: any,
		findings: list("string"),
		risks: list("string"),
		mitigations: list("string"),
		score: num,
	},
	visual_dashboard: {
		visualizationType: any,
		data: any,
		panels: list("object"),
		layout: any,
		interactive: bool,
		uiType: any,
		refreshRate: num,
		externalUrl: any,
	},
	custom_framework: { stages: any, rules: any, metrics: any },
	tree_of_thought: {
		...thoughtFlow,
		depth: num,
		breadth: num,
		branches: any,
		evaluations: any,
		selectedPath: any,
	},
	beam_search: {
		...thoughtFlow,
		beamWidth: num,
		candidates: any,
		scores: any,
		iterations: num,
	},
	mcts: {
		...thoughtFlow,
		simulations: num,
		explorationConstant: num,
		tree: any,
		bestAction: any,
	},
	graph_of_thought: {
		...thoughtFlow,
		nodes: any,
		edges: any,
		paths: any,
		optimalPath: any,
	},
	orchestration_suggest: { createNotebook: bool },
	notebook_create: { pattern: any },
	notebook_add_cell: {
		notebookId: any,
		cellType: any,
		source: any,
		language: any,
		index: num,
	},
	notebook_export: { notebookId: any, format: any },
	ooda_loop: {
		maxLoopTimeMs: num,
		autoAdvance: bool,
		minEvidence: num,
		evidence: list("string"),
		hypotheses: list("object"),
		includeExport: bool,
		sessionId: any,
		// Free text for each phase; each is recorded as a node of that phase.
		observe: softStr("a string"),
		orient: softStr("a string"),
		decide: softStr("a string"),
		act: softStr("a string"),
	},
	ulysses_protocol: {
		timeboxMs: num,
		maxIterations: num,
		minConfidence: num,
		maxScopeDrift: num,
		autoEscalate: bool,
		notifyWhen: any,
		allowOverride: bool,
		confidence: num,
		evidence: list("string"),
		scopeChange: any,
		attemptAdvance: bool,
		makeFinalDecision: bool,
		includeExport: bool,
		sessionId: any,
		decisionRationale: any,
	},
};

/** Operations whose parameters are handled elsewhere or are free-form. */
export const EXEMPT_OPERATIONS: ReadonlySet<string> = new Set([
	"session_info",
	"session_export",
	"session_import",
	"code_execution",
	"notebook_run_cell",
]);

export const hasParamSchema = (operation: string): boolean =>
	operation in SHAPES;

/** Parameter keys an operation reads (undefined for operations without a schema). */
export const paramKeysFor = (operation: string): string[] | undefined =>
	SHAPES[operation] ? Object.keys(SHAPES[operation]) : undefined;

const compiled = new Map<string, z.ZodTypeAny>();
const schemaFor = (operation: string): z.ZodTypeAny | undefined => {
	const shape = SHAPES[operation];
	if (!shape) return undefined;
	let s = compiled.get(operation);
	if (!s) {
		s = z.object(shape).passthrough();
		compiled.set(operation, s);
	}
	return s;
};

const camelCase = (k: string): string =>
	k.trim().replace(/[\s_-]+([A-Za-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Copy `thought_number`-style keys onto their canonical key when absent. */
const applyAliases = (
	shape: Record<string, z.ZodTypeAny>,
	input: Record<string, unknown>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = { ...input };
	for (const [k, v] of Object.entries(input)) {
		if (k in shape) continue;
		const canonical = camelCase(k);
		if (canonical !== k && canonical in shape && !(canonical in input)) {
			out[canonical] = v;
		}
	}
	return out;
};

const formatPath = (path: Path): string =>
	path.reduce<string>(
		(acc, p) =>
			typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p,
		"",
	);

export type ParamValidation =
	| { ok: true; data: Record<string, unknown>; warnings: string[] }
	| { ok: false; issues: string[] };

export function validateParameters(
	operation: string,
	parameters: unknown,
): ParamValidation {
	const input = isPlainObject(parameters) ? parameters : {};
	const schema = schemaFor(operation);
	if (!schema) return { ok: true, data: input, warnings: [] };

	const warnings: string[] = [];
	activeWarnings = warnings;
	let parsed: ReturnType<z.ZodTypeAny["safeParse"]>;
	try {
		parsed = schema.safeParse(applyAliases(SHAPES[operation], input));
	} finally {
		activeWarnings = null;
	}
	if (parsed.success) {
		const shape = SHAPES[operation];
		const ignored = Object.keys(input).filter(
			(k) => !k.startsWith("__") && !(k in shape) && !(camelCase(k) in shape),
		);
		if (ignored.length > 0) {
			warnings.push(
				`${ignored.map((k) => `parameters.${k}`).join(", ")}: not read by ${operation}, ignored. ${operation} reads: ${Object.keys(shape).filter((k) => !k.startsWith("__")).join(", ")}`,
			);
		}
		return {
			ok: true,
			data: parsed.data as Record<string, unknown>,
			warnings,
		};
	}
	return {
		ok: false,
		issues: parsed.error.issues.map(
			(i) => `parameters.${formatPath(i.path as Path)}: ${i.message}`,
		),
	};
}
