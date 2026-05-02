import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "goal.ts");
const PI_EXTENSION_LOADER_PATH = resolvePiExtensionLoaderPath();
const { loadExtensions } = await import(pathToFileURL(PI_EXTENSION_LOADER_PATH).href);

function resolvePiExtensionLoaderPath() {
	const loaderPath = "@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
	try {
		return require.resolve(loaderPath);
	} catch {
		const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		return join(globalNodeModules, loaderPath);
	}
}

async function createHarness(options = {}) {
	const result = await loadExtensions([EXTENSION_PATH], PACKAGE_ROOT);
	assert.equal(
		result.errors.length,
		0,
		`event=goal_extension.load actor=agent operation=load_extension risk=extension_unavailable expected=no load errors actual=${JSON.stringify(
			result.errors,
		)} suggestion=inspect TypeScript imports and Pi extension loader aliases`,
	);
	const extension = result.extensions[0];
	const sentMessages = [];
	const entries = [...(options.entries ?? [])];
	const branchEntries = options.branchEntries ?? entries;
	const notifications = [];
	const statuses = [];
	const widgets = [];
	let idle = options.idle ?? true;
	let pendingMessages = options.pendingMessages ?? false;
	result.runtime.sendMessage = (message, sendOptions) => {
		sentMessages.push({ message, options: sendOptions });
	};
	result.runtime.appendEntry = (customType, data) => {
		const entry = { type: "custom", customType, data };
		entries.push(entry);
		if (branchEntries !== entries) branchEntries.push(entry);
		return entry;
	};

	const ctx = {
		hasUI: true,
		cwd: PACKAGE_ROOT,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branchEntries,
		},
		modelRegistry: {},
		model: undefined,
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		getContextUsage: () => options.contextUsage,
		getSystemPrompt: () => "",
		compact: () => {},
		abort: () => {},
		shutdown: () => {},
		signal: undefined,
		ui: {
			theme: {
				fg: (_color, text) => text,
			},
			notify: (message, type = "info") => notifications.push({ message, type }),
			setStatus: (key, text) => statuses.push({ key, text }),
			setWidget: (key, lines, widgetOptions) => widgets.push({ key, lines, options: widgetOptions }),
			confirm: async () => options.confirm ?? true,
			input: async () => options.input,
		},
	};

	return {
		result,
		extension,
		ctx,
		sentMessages,
		entries,
		notifications,
		statuses,
		widgets,
		setIdle: (value) => {
			idle = value;
		},
		setPendingMessages: (value) => {
			pendingMessages = value;
		},
		command: extension.commands.get("goal"),
		tool: (name) => extension.tools.get(name)?.definition,
		handlers: (name) => extension.handlers.get(name) ?? [],
		async emit(name, event = {}) {
			for (const handler of extension.handlers.get(name) ?? []) {
				await handler({ type: name, ...event }, ctx);
			}
		},
	};
}

async function startGoal(harness, objective = "ship the goal extension") {
	await harness.command.handler(objective, harness.ctx);
}

function latestGoalEntry(harness) {
	const entry = harness.entries.toReversed().find((candidate) => candidate.customType === "pi-goal-state");
	assert.ok(entry, "event=goal_extension.persist actor=extension operation=find_goal_state risk=lost_goal_state expected=custom goal state entry actual=none suggestion=inspect persistGoal");
	return entry;
}

const goalEntry = (overrides = {}) => {
	const timestamp = "2026-05-01T00:00:00.000Z";
	return {
		type: "custom",
		customType: "pi-goal-state",
		data: {
			version: 1,
			goal: {
				id: overrides.id ?? "goal-test-id",
				objective: overrides.objective ?? "keep working from branch state",
				status: overrides.status ?? "active",
				tokenBudget: overrides.tokenBudget ?? null,
				tokensUsed: overrides.tokensUsed ?? 0,
				timeUsedSeconds: overrides.timeUsedSeconds ?? 0,
				createdAt: overrides.createdAt ?? timestamp,
				updatedAt: overrides.updatedAt ?? timestamp,
				continuationSuppressed: overrides.continuationSuppressed ?? false,
				lastContinuationTurnHadNoTools: overrides.lastContinuationTurnHadNoTools ?? false,
			},
		},
	};
};

test("registers the Codex-like goal command, tools, and runtime events", async () => {
	const harness = await createHarness();

	assert.deepEqual([...harness.extension.commands.keys()], ["goal"]);
	assert.deepEqual([...harness.extension.tools.keys()], ["get_goal", "update_goal"]);
	assert.equal(
		harness.extension.handlers.has("before_agent_start"),
		false,
		"event=goal_extension.no_user_turn_injection actor=agent operation=inspect_handlers risk=user_message_overridden expected=no before_agent_start handler actual=registered suggestion=only continue via hidden follow-up messages when idle",
	);
	assert.deepEqual([...harness.extension.handlers.keys()], [
		"session_start",
		"turn_start",
		"tool_execution_end",
		"turn_end",
		"agent_end",
		"session_shutdown",
	]);
});

test("queues one hidden follow-up when /goal creates an active objective while idle", async () => {
	const harness = await createHarness();

	await startGoal(harness, "build the OS");

	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0].message.customType, "pi-goal-continuation");
	assert.equal(harness.sentMessages[0].message.display, false);
	assert.deepEqual(harness.sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(harness.sentMessages[0].message.content, /<untrusted_objective>\nbuild the OS\n<\/untrusted_objective>/);
	assert.match(harness.sentMessages[0].message.content, /perform a completion audit/);
	assert.equal(latestGoalEntry(harness).data.goal.status, "active");
});

test("does not queue automatic continuation over pending user input", async () => {
	const harness = await createHarness({ pendingMessages: true });

	await startGoal(harness, "do not race the user");

	assert.equal(
		harness.sentMessages.length,
		0,
		"event=goal_extension.pending_input actor=user operation=set_goal risk=automatic_turn_races_user expected=no continuation actual=message queued suggestion=check ctx.hasPendingMessages before sendMessage",
	);
	assert.equal(latestGoalEntry(harness).data.goal.status, "active");
});

test("asks for a clearer objective before starting a vague goal", async () => {
	const harness = await createHarness({ input: "improve the goal extension status display" });

	await startGoal(harness, "improve");

	assert.equal(latestGoalEntry(harness).data.goal.objective, "improve the goal extension status display");
	assert.equal(harness.sentMessages.length, 1);
});

test("shows goal help without starting a continuation", async () => {
	const harness = await createHarness();

	await harness.command.handler("help", harness.ctx);

	assert.match(harness.notifications.at(-1).message, /\/goal <objective>/);
	assert.equal(harness.sentMessages.length, 0);
});

test("debug mode writes evlog-compatible goal events", async () => {
	const harness = await createHarness();

	await harness.command.handler("debug on", harness.ctx);
	await startGoal(harness, "debug the continuation loop");

	const debugEntry = harness.entries.toReversed().find((candidate) => candidate.customType === "pi-goal-debug");
	assert.equal(debugEntry.data.enabled, true);
	const eventEntry = harness.entries.find((candidate) => candidate.customType === "pi-goal-debug-event");
	assert.equal(eventEntry.data.service, "pi-goal");
	assert.equal(eventEntry.data.level, "debug");
	assert.equal(eventEntry.data.event, "goal.started");
	assert.equal(eventEntry.data.context.operation, "goal_command");
	assert.equal(typeof eventEntry.data.timestamp, "string");
});

test("continues again after an automatic turn performs tool work", async () => {
	const harness = await createHarness();
	await startGoal(harness);
	harness.sentMessages.length = 0;

	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", { message: { role: "assistant", content: "still working" } });
	await harness.emit("agent_end");

	assert.equal(harness.sentMessages.length, 1);
	assert.equal(harness.sentMessages[0].message.customType, "pi-goal-continuation");
	assert.equal(latestGoalEntry(harness).data.goal.continuationSuppressed, false);
});

test("suppresses runaway continuation after an automatic turn makes no tool calls", async () => {
	const harness = await createHarness();
	await startGoal(harness);
	harness.sentMessages.length = 0;

	await harness.emit("turn_start");
	await harness.emit("turn_end", { message: { role: "assistant", content: "I need input." } });
	await harness.emit("agent_end");

	assert.equal(harness.sentMessages.length, 0);
	const goal = latestGoalEntry(harness).data.goal;
	assert.equal(goal.status, "active");
	assert.equal(goal.continuationSuppressed, true);
	assert.equal(goal.lastContinuationTurnHadNoTools, true);
	assert.match(harness.notifications.at(-1).message, /Use \/goal resume to continue/);
});

test("update_goal only completes the current goal and preserves usage report details", async () => {
	const harness = await createHarness();
	await startGoal(harness, "finish with evidence");

	const updateGoal = harness.tool("update_goal");
	const rejected = await updateGoal.execute("call-1", { status: "paused" }, undefined, undefined, harness.ctx);
	assert.match(rejected.content[0].text, /only set status to complete/);
	assert.equal(latestGoalEntry(harness).data.goal.status, "active");

	const completed = await updateGoal.execute("call-2", { status: "complete" }, undefined, undefined, harness.ctx);
	const details = JSON.parse(completed.content[0].text);
	assert.equal(details.goal.status, "complete");
	assert.equal(latestGoalEntry(harness).data.goal.status, "complete");
});

test("counts assistant turn usage and budget-limits the active goal", async () => {
	const harness = await createHarness();
	await startGoal(harness, "stop when budget is spent --token-budget 10");

	harness.sentMessages.length = 0;
	await harness.emit("turn_start");
	await harness.emit("tool_execution_end");
	await harness.emit("turn_end", {
		message: {
			role: "assistant",
			content: "spent tokens",
			usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
		},
	});

	const goal = latestGoalEntry(harness).data.goal;
	assert.equal(
		goal.tokensUsed,
		12,
		"event=goal_extension.token_accounting actor=runtime operation=turn_end risk=budget_never_trips expected=tokensUsed includes assistant usage totalTokens actual=tokensUsed unchanged suggestion=inspect turn_end usage accounting",
	);
	assert.equal(goal.status, "budget_limited");
	assert.equal(harness.sentMessages.at(-1).message.customType, "pi-goal-context");
});

test("restores goal state from the active branch instead of abandoned entries", async () => {
	const branchGoal = goalEntry({ id: "branch-goal", objective: "continue active branch" });
	const abandonedGoal = goalEntry({ id: "abandoned-goal", objective: "wrong branch", status: "complete" });
	const harness = await createHarness({ entries: [branchGoal, abandonedGoal], branchEntries: [branchGoal] });

	await harness.emit("session_start", { reason: "startup" });
	await new Promise((resolve) => setImmediate(resolve));

	const getGoal = harness.tool("get_goal");
	const result = await getGoal.execute("call-branch", {}, undefined, undefined, harness.ctx);
	const details = JSON.parse(result.content[0].text);
	assert.equal(
		details.goal.id,
		"branch-goal",
		"event=goal_extension.branch_restore actor=runtime operation=session_start risk=wrong_branch_goal_restored expected=active branch goal actual=latest global entry suggestion=use sessionManager.getBranch for state reconstruction",
	);
	assert.equal(harness.sentMessages.at(-1).message.details.goalId, "branch-goal");
});

test("ignores malformed persisted goal entries during session restore", async () => {
	const malformedEntry = {
		type: "custom",
		customType: "pi-goal-state",
		data: { version: 1, goal: { id: "bad", objective: 123, status: "active" } },
	};
	const harness = await createHarness({ entries: [malformedEntry], branchEntries: [malformedEntry] });

	await harness.emit("session_start", { reason: "startup" });

	const getGoal = harness.tool("get_goal");
	const result = await getGoal.execute("call-malformed", {}, undefined, undefined, harness.ctx);
	const details = JSON.parse(result.content[0].text);
	assert.equal(
		details.goal,
		null,
		"event=goal_extension.invalid_state actor=runtime operation=session_start risk=malformed_session_state_poisoning expected=invalid goal ignored actual=invalid goal restored suggestion=validate persisted GoalEntry shape before trusting it",
	);
});

test("assistant text cannot bypass update_goal completion", async () => {
	const harness = await createHarness();
	await startGoal(harness, "only tool completion counts");
	harness.sentMessages.length = 0;

	await harness.emit("turn_start");
	await harness.emit("turn_end", {
		message: {
			role: "assistant",
			content: "[goal complete]",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		},
	});

	assert.equal(
		latestGoalEntry(harness).data.goal.status,
		"active",
		"event=goal_extension.completion_authority actor=assistant operation=turn_end risk=agent_bypasses_completion_audit expected=goal remains active until update_goal or user command actual=text marker completed goal suggestion=remove assistant-text completion sentinel",
	);
});
