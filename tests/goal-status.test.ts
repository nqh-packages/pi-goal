// Tests for goal_status_line tool: validation, format, blocked state rendering
import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, latestGoalEntry, parseToolResponse, plain, startSetup, RICH_OBJECTIVE } from "./helpers.js";

async function activate(h: Awaited<ReturnType<typeof createHarness>>) {
	await startSetup(h, "status test --token-budget 100");
	await h.tool("goal_present")!.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, h.ctx);
	h.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	h.sentMessages.length = 0;
	await h.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, h.ctx);
}

// ─── Validation ───────────────────────────────────────────────────────

test("goal_status_line rejects when no active goal", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_status_line")!.execute("call-no-goal", { text: "working" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_NO_GOAL");
});

test("goal_status_line rejects when goal is blocked", async () => {
	const harness = await createHarness();
	await activate(harness);
	// Create a no-work blocked state
	harness.sentMessages.length = 0;
	await harness.emit("turn_start");
	await harness.emit("turn_end", { message: { role: "assistant", content: "need input" } });
	await harness.emit("agent_end");
	assert.equal(latestGoalEntry(harness).data.goal!.blockedReason, "no_work");
	const result = await harness.tool("goal_status_line")!.execute("call-blocked", { text: "still working" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_BLOCKED");
});

test("goal_status_line rejects empty text", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_status_line")!.execute("call-empty", { text: "" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_VALIDATION");
});

test("goal_status_line rejects text over 64 characters", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_status_line")!.execute("call-long", { text: "x".repeat(65) }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_VALIDATION");
	assert.match(parsed.detail as string, /64 characters or fewer/);
});

test("goal_status_line rejects multi-line text", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_status_line")!.execute("call-multi", { text: "line1\nline2" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_VALIDATION");
});

test("goal_status_line rejects control characters", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_status_line")!.execute("call-ctrl", { text: "bad\x00char" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_STATUS_VALIDATION");
});

test("goal_status_line updates progress on active goal", async () => {
	const harness = await createHarness();
	await activate(harness);
	const originalObjective = latestGoalEntry(harness).data.goal!.objective;
	await harness.tool("goal_status_line")!.execute("call-work", { text: "verifying package" }, undefined, undefined, harness.ctx);
	assert.equal(latestGoalEntry(harness).data.goal!.objective, originalObjective);
	assert.equal(latestGoalEntry(harness).data.goal!.statusLine, "verifying package");
	assert.match(plain(harness.statuses.at(-1)!.text!), /\/goal ◇ [◴◷◶◵] verifying package/);
});

// ─── Format: Status Line Rendering ────────────────────────────────────

test("status line shows working state with clock glyph", async () => {
	const harness = await createHarness();
	await activate(harness);
	const line = plain(harness.statuses.at(-1)!.text!);
	// Should start with /goal ◇ and a clock glyph
	assert.match(line, /^\/goal ◇ [◴◷◶◵]/);
});

test("status line shows answer-needed for waiting_on_user", async () => {
	const harness = await createHarness();
	await activate(harness);
	harness.sentMessages.length = 0;
	// Simulate agent that did tool work then asked a question
	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", { message: { role: "assistant", content: "I need approval. Please confirm." } });
	await harness.emit("agent_end");
	const line = plain(harness.statuses.at(-1)!.text!);
	assert.match(line, /\/goal ◇ \? waiting/);
});

test("status line shows blocked for no-progress suppression", async () => {
	const harness = await createHarness();
	await activate(harness);
	harness.sentMessages.length = 0;
	await harness.emit("turn_start");
	await harness.emit("turn_end", { message: { role: "assistant", content: "waiting" } });
	await harness.emit("agent_end");
	const line = plain(harness.statuses.at(-1)!.text!);
	assert.match(line, /\/goal ◇ blocked: no progress,/);
});

test("status line shows paused state", async () => {
	const harness = await createHarness();
	await activate(harness);
	await harness.command.handler("pause", harness.ctx);
	const line = plain(harness.statuses.at(-1)!.text!);
	assert.match(line, /^\/goal ◇ paused:/);
});

test("status line shows budget limit reached", async () => {
	const harness = await createHarness();
	await startSetup(harness, "budget status --token-budget 10");
	await harness.tool("goal_present")!.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	harness.sentMessages.length = 0;
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", { message: { role: "assistant", content: "spent", usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } } });
	const line = plain(harness.statuses.at(-1)!.text!);
	assert.match(line, /\/goal ◇ blocked: budget used/);
});

test("status line shows complete state", async () => {
	const harness = await createHarness();
	await activate(harness);
	await harness.tool("goal_complete")!.execute("call-done", { status: "complete" }, undefined, undefined, harness.ctx);
	const line = plain(harness.statuses.at(-1)!.text!);
	assert.match(line, /\/goal ◇ ✓ done/);
});

test("status line clock advances without agent status updates", async () => {
	const harness = await createHarness();
	await activate(harness);
	const first = harness.statuses.at(-1)?.text;
	await new Promise((resolve) => setTimeout(resolve, 900));
	const second = harness.statuses.at(-1)?.text;
	assert.notEqual(second, first, "event=goal.status_heartbeat actor=runtime operation=active_goal_render risk=fake_activity_signal expected=clock frame advances without agent status update actual=status line stayed static suggestion=inspect heartbeat timer lifecycle");
	await harness.command.handler("cancel", harness.ctx);
});
