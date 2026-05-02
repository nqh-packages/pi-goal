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
	const entries = [];
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
		return entry;
	};

	const ctx = {
		hasUI: true,
		cwd: PACKAGE_ROOT,
		sessionManager: {
			getEntries: () => entries,
		},
		modelRegistry: {},
		model: undefined,
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		getContextUsage: () => undefined,
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
