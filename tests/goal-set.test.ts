// Tests for goal_set, goal_present, and goal_get tools
import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, latestGoalEntry, parseToolResponse, startSetup, RICH_OBJECTIVE, type HarnessReturn, type GoalData } from "./helpers.js";

async function activate(harness: HarnessReturn): Promise<GoalData> {
	const presentTool = harness.tool("goal_present")!;
	await presentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	return latestGoalEntry(harness).data.goal!;
}

// ─── goal_set Gates ───────────────────────────────────────────────────

test("goal_set rejects without active setup", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_set")!.execute("call-missing", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_NO_SETUP");
});

test("goal_set rejects without confirmed=true", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const result = await harness.tool("goal_set")!.execute("call-unconfirmed", { confirmed: false, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_NOT_CONFIRMED");
});

test("goal_set rejects when contract not presented", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const result = await harness.tool("goal_set")!.execute("call-no-present", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_NO_CONTRACT");
});

test("goal_set rejects when objective differs from presented", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const modified = RICH_OBJECTIVE.replace("ship", "revise");
	const result = await harness.tool("goal_set")!.execute("call-different", { confirmed: true, objective: modified }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_NO_CONTRACT");
});

test("goal_set rejects with token_budget override", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const result = await harness.tool("goal_set")!.execute("call-budget-override", { confirmed: true, objective: RICH_OBJECTIVE, token_budget: 999 }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_BUDGET_OVERRIDE");
});

test("goal_set rejects when active goal exists", async () => {
	const createdAt = "2026-05-01T00:00:00.000Z";
	const setupEntry = {
		id: "setup-active",
		generation: 2,
		intent: "replacement attempt",
		tokenBudget: null,
		phase: "interviewing" as const,
		contractPresentedAt: createdAt,
		contractObjective: RICH_OBJECTIVE,
		createdAt,
		updatedAt: createdAt,
	};
	const entry = {
		type: "custom" as const, customType: "pi-goal-state" as const,
		data: { version: 1, setup: setupEntry, goal: { id: "existing", generation: 1, objective: RICH_OBJECTIVE, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt, updatedAt: createdAt, continuationSuppressed: false, lastContinuationTurnHadNoTools: false, statusLine: "working", blockedReason: null } },
	};
	const harness = await createHarness({ entries: [entry], branchEntries: [entry] });
	await harness.emit("session_start", { reason: "startup" });
	const result = await harness.tool("goal_set")!.execute("call-active", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_ACTIVE_GOAL");
});

test("goal_set succeeds with confirmed + matching objective", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 1500");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	harness.sentMessages.length = 0;
	const result = await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.status, "success");
	assert.equal((parsed.goal as Record<string, unknown>).status, "active");
	assert.equal((parsed.goal as Record<string, unknown>).tokenBudget, 1500);
	const goalEntry = latestGoalEntry(harness).data;
	assert.equal(goalEntry.setup, null);
	assert.equal(goalEntry.goal!.status, "active");
});

// ─── goal_set Edge Cases ──────────────────────────────────────────────

test("goal_set with empty objective string is rejected", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test");
	const result = await harness.tool("goal_set")!.execute("call-empty", { confirmed: true, objective: "" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.ok(parsed.error_code === "GOAL_SET_VALIDATION" || parsed.error_code === "VALIDATION_EMPTY_OBJECTIVE");
});

test("goal_set with token_budget: 0 is rejected", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const result = await harness.tool("goal_set")!.execute("call-zero", { confirmed: true, objective: RICH_OBJECTIVE, token_budget: 0 }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_VALIDATION");
});

test("goal_set with token_budget: -1 is rejected", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 100");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const result = await harness.tool("goal_set")!.execute("call-negative", { confirmed: true, objective: RICH_OBJECTIVE, token_budget: -1 }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_SET_VALIDATION");
});

test("goal_set produces toolResponse JSON with all required fields on success", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test --token-budget 500");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	const result = await harness.tool("goal_set")!.execute("call-check", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.status, "success");
	assert.ok("goal" in parsed);
	assert.ok((parsed.goal as Record<string, unknown>).status === "active");
	assert.ok(typeof (parsed.goal as Record<string, unknown>).id === "string");
});

test("goal_set response detail explains error for missing setup", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_set")!.execute("call-detail", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.ok(typeof parsed.detail === "string" && (parsed.detail as string).length > 0);
	assert.ok(Array.isArray(parsed.suggestions) && (parsed.suggestions as unknown[]).length > 0);
});

// ─── goal_present ────────────────────────────────────────────────────

test("goal_present rejects without active setup", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_present")!.execute("call-no-setup", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_PRESENT_NO_SETUP");
});

test("goal_present rejects malformed objective", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test");
	const result = await harness.tool("goal_present")!.execute("call-bad", { objective: "Do stuff" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_PRESENT_VALIDATION");
});

test("goal_present records contract and can be updated", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test");
	const goalPresentTool = harness.tool("goal_present")!;
	// First presentation
	const first = await goalPresentTool.execute("call-first", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	assert.equal(parseToolResponse(first).status, "success");
	// Second presentation with different objective (e.g. after user feedback)
	const revised = RICH_OBJECTIVE.replace("ship", "finalize");
	const second = await goalPresentTool.execute("call-second", { objective: revised }, undefined, undefined, harness.ctx);
	assert.equal(parseToolResponse(second).status, "success");
	// goal_set should match the LATEST presentation, not the first
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	const setResult = await harness.tool("goal_set")!.execute("call-final", { confirmed: true, objective: revised }, undefined, undefined, harness.ctx);
	assert.equal(parseToolResponse(setResult).status, "success");
});

// ─── goal_get ─────────────────────────────────────────────────────────

test("goal_get returns null state before any setup", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_get")!.execute("call-empty", {}, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.goal, null);
	assert.equal(parsed.setup, null);
});

test("goal_get returns setup state during interviewing phase", async () => {
	const harness = await createHarness();
	await startSetup(harness, "get test --token-budget 200");
	const result = await harness.tool("goal_get")!.execute("call-during", {}, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.goal, null);
	assert.ok(parsed.setup != null);
	assert.equal((parsed.setup as Record<string, unknown>).intent, "get test");
});

test("goal_get returns active goal after activation", async () => {
	const harness = await createHarness();
	// Manually activate to ensure proper ordering
	await startSetup(harness, "get test --token-budget 100");
	const presentResult = await harness.tool("goal_present")!.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	assert.equal(parseToolResponse(presentResult).status, "success");
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	const setResult = await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	assert.equal(parseToolResponse(setResult).status, "success");
	const goal = latestGoalEntry(harness).data.goal;
	assert.ok(goal, "goal should exist after goal_set");
	const result = await harness.tool("goal_get")!.execute("call-after", {}, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal((parsed.goal as Record<string, unknown>).id, goal!.id);
	assert.equal((parsed.goal as Record<string, unknown>).status, "active");
});
