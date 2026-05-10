// Tests for the /goal command handler: registration, setup, help, cancel, pause, resume, legacy commands
import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, latestGoalEntry, plain, startSetup, RICH_OBJECTIVE, type HarnessReturn } from "./helpers.js";

test("registers setup-first goal command, new tools, and runtime events", async () => {
	const harness = await createHarness();
	assert.deepEqual([...harness.extension.commands.keys()], ["goal"]);
	assert.deepEqual(new Set(harness.extension.tools.keys()), new Set(["goal_set", "goal_get", "goal_present", "goal_status_line", "goal_complete"]));
	assert.equal(harness.tool("get_goal"), undefined);
	assert.equal(harness.tool("update_goal"), undefined);
	assert.equal((harness.extension.handlers as Map<string, unknown>).has("before_agent_start"), false);
	assert.deepEqual([...harness.extension.handlers.keys()], ["session_start", "turn_start", "tool_execution_end", "turn_end", "agent_end", "session_shutdown"]);
});

test("/goal intent starts setup mode without activating a goal", async () => {
	const harness = await createHarness();
	await startSetup(harness, "publish the package --token-budget 1200");
	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0].message.customType, "pi-goal-setup");
	assert.equal(harness.sentMessages[0].message.display, false);
	assert.deepEqual(harness.sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(harness.sentMessages[0].message.content, /Outcome:/);
	assert.match(harness.sentMessages[0].message.content, /Done criteria:/);
	assert.match(harness.sentMessages[0].message.content, /Decision philosophy:/);
	assert.match(harness.sentMessages[0].message.content, /Ask-before boundaries:/);
	assert.match(harness.sentMessages[0].message.content, /<untrusted_goal_intent/);
	assert.match(harness.sentMessages[0].message.content, /Do not start implementation work yet and do not call goal_set yet/);
	assert.match(harness.sentMessages[0].message.content, /Phase 0.*Budget/);
	assert.match(harness.sentMessages[0].message.content, /Phase 1.*Outcome/);
	assert.match(harness.sentMessages[0].message.content, /Phase 3.*MUST DO/);
	assert.match(harness.sentMessages[0].message.content, /Phase 4.*AVOID/);
	assert.match(harness.sentMessages[0].message.content, /Only after approval, call goal_set with confirmed true/);
	assert.match(harness.sentMessages[0].message.content, /confirmed true/);
	assert.doesNotMatch(harness.sentMessages[0].message.content, /token_budget/);
	const entry = latestGoalEntry(harness).data;
	assert.equal(entry.goal, null);
	assert.equal(entry.setup!.intent, "publish the package");
	assert.equal(entry.setup!.tokenBudget, 1200);
	assert.match(plain(harness.statuses.at(-1)!.text!), /\/goal ◇ setup: publish the package/);
});

test("setup does not queue follow-up over pending user input", async () => {
	const harness = await createHarness({ pendingMessages: true });
	await startSetup(harness, "do not race the user");
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(latestGoalEntry(harness).data.setup!.intent, "do not race the user");
	assert.equal(latestGoalEntry(harness).data.goal, null);
});

test("help lists only the new grammar and legacy commands reject", async () => {
	const harness = await createHarness();
	await harness.command.handler("help", harness.ctx);
	assert.match(harness.notifications.at(-1)!.message, /\/goal <intent>/);
	assert.match(harness.notifications.at(-1)!.message, /\/goal cancel/);
	assert.doesNotMatch(harness.notifications.at(-1)!.message, /\/goal clear|update_goal|get_goal/);
	for (const legacyCommand of ["clear", "complete", "done", "unpause", "debug", "debug on", "debug off", "debug status"]) {
		await harness.command.handler(legacyCommand, harness.ctx);
		assert.equal(harness.notifications.at(-1)!.type, "warning");
		assert.match(harness.notifications.at(-1)!.message, new RegExp(`Unsupported /goal command: ${legacyCommand}`));
	}
	assert.equal(harness.entries.length, 0);
});

test("quoted reserved words are literal setup intents", async () => {
	const harness = await createHarness();
	await startSetup(harness, '"status"');
	assert.equal(latestGoalEntry(harness).data.setup!.intent, "status");
	assert.equal(harness.sentMessages.at(-1)!.message.customType, "pi-goal-setup");
});



test("pause, resume, and cancel use status-line-only UI", async () => {
	const harness = await createHarness();
	// Activate a goal first
	await startSetup(harness, "test PRC --token-budget 100");
	const presentTool = harness.tool("goal_present")!;
	await presentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const entry = { type: "message", message: { role: "user" as const, content: "approved" } };
	harness.entries.push(entry);
	harness.sentMessages.length = 0;
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);

	harness.sentMessages.length = 0;
	await harness.command.handler("pause", harness.ctx);
	assert.equal(latestGoalEntry(harness).data.goal!.status, "paused");
	assert.match(plain(harness.statuses.at(-1)!.text!), /^\/goal ◇ paused:/);
	assert.equal(harness.widgets.at(-1)?.lines, undefined);
	await harness.command.handler("resume", harness.ctx);
	assert.equal(latestGoalEntry(harness).data.goal!.status, "active");
	assert.equal(harness.sentMessages.at(-1)!.message.customType, "pi-goal-continuation");
	await harness.command.handler("cancel", harness.ctx);
	assert.equal(latestGoalEntry(harness).data.goal, null);
	assert.equal(latestGoalEntry(harness).data.setup, null);
	assert.equal(harness.statuses.at(-1)!.text, undefined);
});

test("cancel when nothing is active produces no error", async () => {
	const harness = await createHarness();
	await harness.command.handler("cancel", harness.ctx);
	// Should quietly succeed — null state is valid
	assert.equal(latestGoalEntry(harness).data.goal, null);
	assert.equal(latestGoalEntry(harness).data.setup, null);
});

test("pause without active goal shows warning", async () => {
	const harness = await createHarness();
	await harness.command.handler("pause", harness.ctx);
	assert.equal(harness.notifications.at(-1)!.type, "warning");
});

test("resume without active goal shows warning", async () => {
	const harness = await createHarness();
	await harness.command.handler("resume", harness.ctx);
	assert.equal(harness.notifications.at(-1)!.type, "warning");
});

test("resume while waiting on user shows warning", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test resume --token-budget 100");
	const presentTool = harness.tool("goal_present")!;
	await presentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const entry = { type: "message", message: { role: "user" as const, content: "approved" } };
	harness.entries.push(entry);
	harness.sentMessages.length = 0;
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	// Simulate assistant asking a question
	harness.sentMessages.length = 0;
	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", { message: { role: "assistant", content: "I need approval. Please confirm." } });
	await harness.emit("agent_end");
	assert.equal(latestGoalEntry(harness).data.goal!.blockedReason, "waiting_on_user");
	await harness.command.handler("resume", harness.ctx);
	// Should show warning, not actually resume
	assert.equal(harness.notifications.at(-1)!.type, "warning");
});

test("resume while budget limited shows warning", async () => {
	const harness = await createHarness();
	await startSetup(harness, "test budget resume --token-budget 10");
	const presentTool = harness.tool("goal_present")!;
	await presentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const entry = { type: "message", message: { role: "user" as const, content: "approved" } };
	harness.entries.push(entry);
	harness.sentMessages.length = 0;
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	// Exhaust budget
	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", { message: { role: "assistant", content: "spent", usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } } });
	assert.equal(latestGoalEntry(harness).data.goal!.status, "budget_limited");
	await harness.command.handler("resume", harness.ctx);
	assert.equal(harness.notifications.at(-1)!.type, "warning");
	assert.match(harness.notifications.at(-1)!.message, /[Bb]udget/);
});

test("active goal blocks new setup", async () => {
	const harness = await createHarness();
	await startSetup(harness, "first goal --token-budget 100");
	const presentTool = harness.tool("goal_present")!;
	await presentTool.execute("call-present", { objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	const entry = { type: "message", message: { role: "user" as const, content: "approved" } };
	harness.entries.push(entry);
	harness.sentMessages.length = 0;
	await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective: RICH_OBJECTIVE }, undefined, undefined, harness.ctx);
	// Try starting a new goal while one is active
	harness.sentMessages.length = 0;
	await harness.command.handler("second goal while active", harness.ctx);
	assert.equal(harness.notifications.at(-1)!.type, "warning");
	assert.equal(harness.sentMessages.length, 0); // no setup prompt queued
});
