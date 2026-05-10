/**
 * Structured message tests for the pi-goal extension.
 *
 * Follows test-systematically methodology:
 * - toolResponse helper produces required write-dev-logs fields
 * - message constants are stable and complete
 * - success responses include goal state
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	toolResponse,
	toolSuccessResponse,
	GOAL_SET_ERRORS,
	GOAL_STATUS_LINE_ERRORS,
	GOAL_COMPLETE_ERRORS,
	GOAL_PRESENT_ERRORS,
	VALIDATION_ERRORS,
	EVENTS,
} from "./extensions/goal/messages.js";
import type { GoalToolDetails } from "./extensions/goal/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const MOCK_DETAILS: GoalToolDetails = {
	goal: {
		id: "test-goal-id",
		generation: 1,
		objective: "Outcome: test\nDone criteria: passes\nDecision philosophy: simple\nAsk-before boundaries: none",
		status: "active",
		tokenBudget: 1000,
		tokensUsed: 250,
		timeUsedSeconds: 120,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		continuationSuppressed: false,
		lastContinuationTurnHadNoTools: false,
		statusLine: "working through tests",
		blockedReason: null,
	},
	setup: null,
	remainingTokens: 750,
	completionBudgetReport: null,
};

function parseResponse(response: ReturnType<typeof toolResponse>): Record<string, unknown> {
	return JSON.parse(response.content[0].text);
}

// ─── Required Field Keys ──────────────────────────────────────────────

const REQUIRED_ERROR_KEYS = ["type", "status", "error_code", "detail", "suggestions"] as const;
const REQUIRED_ERROR_KEY_SET = new Set<string>(REQUIRED_ERROR_KEYS);

function assertHasRequiredKeys(parsed: Record<string, unknown>, source: string) {
	for (const key of REQUIRED_ERROR_KEYS) {
		assert.ok(
			key in parsed,
			`event=messages.required_field actor=test operation=assert_required_field risk=agent_cannot_self_heal expected=${key} present in ${source} actual=missing suggestion=check messages.ts for missing field`,
		);
	}
	// suggestions must be an array
	assert.ok(Array.isArray(parsed.suggestions), `event=messages.suggestions_type actor=test operation=assert_suggestions_type risk=agent_cannot_self_heal expected=suggestions to be array in ${source} actual=${typeof parsed.suggestions} suggestion=check messages.ts ToolResponseMeta type`);
	// error_code must be non-empty string
	assert.equal(typeof parsed.error_code, "string", `event=messages.error_code_type actor=test operation=assert_error_code_type risk=agent_cannot_self_heal expected=string error_code in ${source} actual=${typeof parsed.error_code} suggestion=check messages.ts ToolResponseMeta type`);
	assert.ok((parsed.error_code as string).length > 0, `event=messages.error_code_empty actor=test operation=assert_error_code_nonempty risk=agent_cannot_self_heal expected=non-empty error_code in ${source} actual=empty suggestion=check messages.ts for empty string error_code`);
	// status must be "success" or "rejected"
	assert.ok(parsed.status === "success" || parsed.status === "rejected", `event=messages.status_value actor=test operation=assert_status_value risk=agent_cannot_diagnose expected=status 'success' or 'rejected' in ${source} actual=${parsed.status} suggestion=check messages.ts status field`);
}

// ─── toolResponse Helper Tests ────────────────────────────────────────

test("toolResponse error produces valid JSON with all required write-dev-logs fields", () => {
	const response = toolResponse(GOAL_SET_ERRORS.NO_SETUP, MOCK_DETAILS);
	const parsed = parseResponse(response);
	assertHasRequiredKeys(parsed, "toolResponse(GOAL_SET_ERRORS.NO_SETUP)");
	assert.equal(parsed.error_code, "GOAL_SET_NO_SETUP");
	assert.equal(parsed.type, "https://pi.local/goal/error/no_setup");
	assert.equal(parsed.status, "rejected");
});

test("toolResponse error includes detail explaining this specific failure", () => {
	for (const [name, constant] of Object.entries(GOAL_SET_ERRORS)) {
		const value = typeof constant === "function" ? (constant as (arg: unknown) => typeof GOAL_SET_ERRORS.NO_SETUP)(100) : constant;
		const response = toolResponse(value, MOCK_DETAILS);
		const parsed = parseResponse(response);
		assert.ok(typeof parsed.detail === "string" && (parsed.detail as string).length > 0, `event=messages.detail_present actor=test operation=assert_detail_present risk=agent_cannot_understand_failure expected=non-empty detail in GOAL_SET_ERRORS.${name} actual=${parsed.detail} suggestion=check messages.ts GOAL_SET_ERRORS.${name}`);
	}
});

test("toolResponse error includes suggestions array for agent self-healing", () => {
	for (const [name, constant] of Object.entries(GOAL_SET_ERRORS)) {
		const value = typeof constant === "function" ? (constant as (arg: unknown) => typeof GOAL_SET_ERRORS.NO_SETUP)(100) : constant;
		const response = toolResponse(value, MOCK_DETAILS);
		const parsed = parseResponse(response);
		assert.ok(Array.isArray(parsed.suggestions) && (parsed.suggestions as unknown[]).length > 0, `event=messages.suggestions_nonempty actor=test operation=assert_suggestions_nonempty risk=agent_cannot_recover expected=non-empty suggestions in GOAL_SET_ERRORS.${name} actual=empty suggestion=check messages.ts GOAL_SET_ERRORS.${name}`);
	}
});

test("toolResponse passes details through to output", () => {
	const response = toolResponse(GOAL_SET_ERRORS.NO_SETUP, MOCK_DETAILS);
	assert.equal(response.details, MOCK_DETAILS);
});

test("toolResponse without details omits details key", () => {
	const response = toolResponse(GOAL_SET_ERRORS.NO_SETUP);
	assert.equal(response.details, undefined);
});

// ─── toolSuccessResponse Tests ────────────────────────────────────────

test("toolSuccessResponse includes goal state and success status", () => {
	const response = toolSuccessResponse(MOCK_DETAILS);
	const parsed = parseResponse(response);
	assert.equal(parsed.status, "success");
	assert.equal((parsed.goal as Record<string, unknown>).id, "test-goal-id");
	assert.equal((parsed.goal as Record<string, unknown>).status, "active");
});

test("toolSuccessResponse passes GoalToolDetails through details property", () => {
	const response = toolSuccessResponse(MOCK_DETAILS);
	assert.equal(response.details, MOCK_DETAILS);
	assert.equal((response.details as GoalToolDetails).remainingTokens, 750);
});

// ─── GOAL_SET_ERRORS Constant Stability ───────────────────────────────

test("all GOAL_SET_ERRORS constants have required fields", () => {
	const staticConstants: Record<string, Record<string, unknown>> = {};
	const dynamicFactories: Record<string, (arg: unknown) => Record<string, unknown>> = {};

	for (const [name, value] of Object.entries(GOAL_SET_ERRORS)) {
		if (typeof value === "function") {
			dynamicFactories[name] = value as unknown as (arg: unknown) => Record<string, unknown>;
		} else {
			staticConstants[name] = value as Record<string, unknown>;
		}
	}

	// Test static constants
	for (const [name, constant] of Object.entries(staticConstants)) {
		assertHasRequiredKeys(constant, `GOAL_SET_ERRORS.${name}`);
	}

	// Test dynamic factories
	for (const [name, factory] of Object.entries(dynamicFactories)) {
		const instance = factory(name === "BUDGET_OVERRIDE" ? 100 : "test");
		assertHasRequiredKeys(instance, `GOAL_SET_ERRORS.${name}(...)`);
	}
});

// ─── GOAL_STATUS_LINE_ERRORS Constant Stability ──────────────────────

test("GOAL_STATUS_LINE_ERRORS have required fields", () => {
	assertHasRequiredKeys(GOAL_STATUS_LINE_ERRORS.NO_ACTIVE_GOAL, "GOAL_STATUS_LINE_ERRORS.NO_ACTIVE_GOAL");
	const blocked = GOAL_STATUS_LINE_ERRORS.BLOCKED("no_work");
	assertHasRequiredKeys(blocked, "GOAL_STATUS_LINE_ERRORS.BLOCKED(...)");
});

// ─── GOAL_COMPLETE_ERRORS Constant Stability ─────────────────────────

test("GOAL_COMPLETE_ERRORS have required fields", () => {
	assertHasRequiredKeys(GOAL_COMPLETE_ERRORS.WRONG_STATUS, "GOAL_COMPLETE_ERRORS.WRONG_STATUS");
	assertHasRequiredKeys(GOAL_COMPLETE_ERRORS.NO_GOAL, "GOAL_COMPLETE_ERRORS.NO_GOAL");
});

// ─── GOAL_PRESENT_ERRORS Constant Stability ──────────────────────────

test("GOAL_PRESENT_ERRORS have required fields", () => {
	assertHasRequiredKeys(GOAL_PRESENT_ERRORS.NO_SETUP, "GOAL_PRESENT_ERRORS.NO_SETUP");
});

// ─── VALIDATION_ERRORS Constant Stability ────────────────────────────

test("VALIDATION_ERRORS constants have required fields", () => {
	// Static validation constants
	assertHasRequiredKeys(VALIDATION_ERRORS.EMPTY_INTENT, "VALIDATION_ERRORS.EMPTY_INTENT");
	assertHasRequiredKeys(VALIDATION_ERRORS.EMPTY_OBJECTIVE, "VALIDATION_ERRORS.EMPTY_OBJECTIVE");
	assertHasRequiredKeys(VALIDATION_ERRORS.EMPTY_PROGRESS, "VALIDATION_ERRORS.EMPTY_PROGRESS");

	// Dynamic validation constants
	const longIntent = VALIDATION_ERRORS.LONG_INTENT(1500);
	assertHasRequiredKeys(longIntent, "VALIDATION_ERRORS.LONG_INTENT(...)");
	const missingLabel = VALIDATION_ERRORS.MISSING_OBJECTIVE_LABEL("Outcome:");
	assertHasRequiredKeys(missingLabel, "VALIDATION_ERRORS.MISSING_OBJECTIVE_LABEL(...)");
});

// ─── EVENTS Constant Stability ───────────────────────────────────────

test("EVENTS constants are non-empty strings", () => {
	for (const [name, value] of Object.entries(EVENTS)) {
		assert.equal(typeof value, "string", `event=messages.event_type actor=test operation=assert_event_type risk=agent_event_drift expected=string EVENTS.${name} actual=${typeof value} suggestion=check messages.ts EVENTS constant`);
		assert.ok((value as string).length > 0, `event=messages.event_empty actor=test operation=assert_event_nonempty risk=agent_event_drift expected=non-empty EVENTS.${name} actual=empty suggestion=check messages.ts EVENTS constant`);
	}
});

// ─── error_code Uniqueness ─────────────────────────────────────────

test("all error_code values are unique across message groups", () => {
	const seen = new Set<string>();
	const groups: Record<string, Record<string, unknown>[]> = {
		"GOAL_SET_ERRORS": Object.values(GOAL_SET_ERRORS).map((v: unknown) => typeof v === "function" ? (v as (arg: unknown) => Record<string, unknown>)("test") : v) as Record<string, unknown>[],
		"GOAL_STATUS_LINE_ERRORS": [GOAL_STATUS_LINE_ERRORS.NO_ACTIVE_GOAL, GOAL_STATUS_LINE_ERRORS.BLOCKED("test")],
		"GOAL_COMPLETE_ERRORS": Object.values(GOAL_COMPLETE_ERRORS).map((v) => v) as Record<string, unknown>[],
		"GOAL_PRESENT_ERRORS": Object.values(GOAL_PRESENT_ERRORS).map((v) => v) as Record<string, unknown>[],
	};

	for (const [group, constants] of Object.entries(groups)) {
		for (const constant of constants) {
			const code = constant.error_code as string;
			if (seen.has(code)) {
				assert.fail(`event=messages.duplicate_error_code actor=test operation=assert_unique_error_codes risk=agent_cannot_disambiguate expected=unique error_code across groups actual=duplicate '${code}' suggested=use distinct prefix for each group`);
			}
			seen.add(code);
		}
	}
});
