// Tests for goal_complete tool: gates, success, bypass prevention
import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, latestGoalEntry, parseToolResponse, plain, startSetup, RICH_OBJECTIVE } from "./helpers.js";

async function activate(h: Awaited<ReturnType<typeof createHarness>>) {
	await startSetup(h, "complete test --token-budget 100");
	await h.tool("goal_present")!.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, h.ctx);
	h.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	h.sentMessages.length = 0;
	await h.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, h.ctx);
}

test("goal_complete rejects non-complete status", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_complete")!.execute("call-paused", { status: "paused" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_COMPLETE_STATUS");
});

test("goal_complete rejects with no active goal", async () => {
	const harness = await createHarness();
	const result = await harness.tool("goal_complete")!.execute("call-none", { status: "complete" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.error_code, "GOAL_COMPLETE_NO_GOAL");
});

test("goal_complete succeeds with status=complete", async () => {
	const harness = await createHarness();
	await activate(harness);
	const result = await harness.tool("goal_complete")!.execute("call-done", { status: "complete" }, undefined, undefined, harness.ctx);
	const parsed = parseToolResponse(result);
	assert.equal(parsed.status, "success");
	assert.equal((parsed.goal as Record<string, unknown>).status, "complete");
	assert.equal(latestGoalEntry(harness).data.goal!.status, "complete");
	assert.match(plain(harness.statuses.at(-1)!.text!), /\/goal ◇ ✓ done/);
});

test("goal_complete clears persistent status after agent_end", async () => {
	const harness = await createHarness();
	await activate(harness);
	await harness.tool("goal_complete")!.execute("call-clear", { status: "complete" }, undefined, undefined, harness.ctx);
	await harness.emit("agent_end");
	// Status and goal should be cleared
	const entry = latestGoalEntry(harness);
	assert.equal(entry.data.goal, null);
	assert.equal(harness.statuses.at(-1)!.text, undefined);
});

test("assistant text cannot bypass goal_complete gate", async () => {
	const harness = await createHarness();
	await activate(harness);
	// Assistant writes "complete" in text but doesn't call the tool
	await harness.emit("turn_start");
	await harness.emit("turn_end", { message: { role: "assistant", content: "[goal complete]", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
	// Goal should still be active
	assert.equal(latestGoalEntry(harness).data.goal!.status, "active");
});

test("new setup can start after goal is complete", async () => {
	const harness = await createHarness();
	await activate(harness);
	await harness.tool("goal_complete")!.execute("call-done", { status: "complete" }, undefined, undefined, harness.ctx);
	await harness.emit("agent_end");
	// Now start a new goal
	await startSetup(harness, "new goal after complete");
	assert.equal(latestGoalEntry(harness).data.setup!.intent, "new goal after complete");
	const goalPresentTool = harness.tool("goal_present")!;
	await goalPresentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	harness.entries.push({ type: "message", message: { role: "user", content: "approved" } });
	await harness.tool("goal_set")!.execute("call-new", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	assert.equal(latestGoalEntry(harness).data.goal!.status, "active");
});
