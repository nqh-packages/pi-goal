// Shared test harness and fixtures for pi-goal tests
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

export const require = createRequire(import.meta.url);
export const PACKAGE_ROOT = (() => {
	const selfPath = dirname(fileURLToPath(import.meta.url));
	// If running from tests/, go up one level to reach package root
	return selfPath.endsWith("/tests") ? dirname(selfPath) : selfPath;
})();
export const EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "goal.ts");
export const UI_CAPTURE_DIR = join(PACKAGE_ROOT, "codex-scripts", "goal-ui");
const PI_EXTENSION_LOADER_PATH = resolvePiExtensionLoaderPath();
const { loadExtensions } = await import(pathToFileURL(PI_EXTENSION_LOADER_PATH).href);

export const RICH_OBJECTIVE = [
	"Outcome: ship the redesigned goal mode.",
	"Done criteria: tests pass, UI capture exists, and docs mention the new grammar.",
	"MUST DO: run the full test suite, write e2e results, update docs.",
	"AVOID: breaking existing tests, publishing without approval.",
	"Decision philosophy: prefer runtime gates over prompt-only behavior.",
	"Ask-before boundaries: ask before publishing or deleting user work.",
].join("\n");

export interface HarnessOptions {
	entries?: unknown[];
	branchEntries?: unknown[];
	idle?: boolean;
	pendingMessages?: boolean;
	confirm?: boolean;
	input?: string;
	contextUsage?: unknown;
}

export interface HarnessReturn {
	result: { errors: unknown[]; extensions: unknown[] };
	extension: {
		commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
		tools: Map<string, { definition: { execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[]; details?: unknown }> } }>;
		handlers: Map<string, unknown[]>;
	};
	ctx: Record<string, unknown>;
	sentMessages: { message: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> }; options?: Record<string, unknown> }[];
	entries: { type: string; customType?: string; data?: unknown; message?: { role: string; content: unknown } }[];
	notifications: { message: string; type: string }[];
	statuses: { key: string; text: string | undefined }[];
	widgets: { key: string; lines: unknown; options: unknown }[];
	setIdle: (value: boolean) => void;
	setPendingMessages: (value: boolean) => void;
	command: { handler: (args: string, ctx: unknown) => Promise<void> };
	tool: (name: string) => {
		execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
	} | undefined;
	handlers: (name: string) => { type?: string; message?: { role: string; content: unknown; usage?: Record<string, number> } }[];
	emit: (name: string, event?: Record<string, unknown>) => Promise<void>;
}

export type GoalData = { id: string; status: string; objective: string; statusLine: string; tokenBudget: number | null };
export type SetupData = { id: string; tokenBudget: number | null; intent: string; phase: string };

function resolvePiExtensionLoaderPath(): string {
	const localLoaderPath = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "index.js");
	try {
		require.resolve(localLoaderPath);
		return localLoaderPath;
	} catch {
		const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8", cwd: PACKAGE_ROOT }).trim();
		const globalLoaderPath = join(globalNodeModules, "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "index.js");
		if (existsSync(globalLoaderPath)) return globalLoaderPath;
		return "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
	}
}

export async function createHarness(options: HarnessOptions = {}): Promise<HarnessReturn> {
	const result = await loadExtensions([EXTENSION_PATH], PACKAGE_ROOT);
	assert.equal(result.errors.length, 0, `event=goal_extension.load actor=agent operation=load_extension risk=extension_unavailable expected=no load errors actual=${JSON.stringify(result.errors)} suggestion=inspect TypeScript imports and Pi extension loader aliases`);
	const extension = result.extensions[0] as HarnessReturn["extension"];
	const sentMessages: HarnessReturn["sentMessages"] = [];
	const entries: HarnessReturn["entries"] = [...(options.entries ?? [])];
	const branchEntries: HarnessReturn["entries"] = options.branchEntries ?? entries;
	const notifications: HarnessReturn["notifications"] = [];
	const statuses: HarnessReturn["statuses"] = [];
	const widgets: HarnessReturn["widgets"] = [];
	let idle = options.idle ?? true;
	let pendingMessages = options.pendingMessages ?? false;
	result.runtime.sendMessage = (message: unknown, sendOptions: unknown) => sentMessages.push({ message, options: sendOptions } as HarnessReturn["sentMessages"][0]);
	result.runtime.appendEntry = (customType: string, data: unknown) => {
		const entry = { type: "custom" as const, customType, data };
		entries.push(entry);
		if (branchEntries !== entries) branchEntries.push(entry as HarnessReturn["entries"][0]);
		return entry;
	};

	const ctx = {
		hasUI: true,
		cwd: PACKAGE_ROOT,
		sessionManager: { getEntries: () => entries, getBranch: () => branchEntries },
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
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string, type = "info") => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			setWidget: (key: string, lines: unknown, widgetOptions: unknown) => widgets.push({ key, lines, options: widgetOptions }),
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
		setIdle: (value: boolean) => { idle = value; },
		setPendingMessages: (value: boolean) => { pendingMessages = value; },
		command: extension.commands.get("goal")!,
		tool: (name: string) => extension.tools.get(name)?.definition,
		handlers: (name: string) => [...(extension.handlers.get(name) ?? [])] as unknown as HarnessReturn["handlers"],
		async emit(name: string, event: Record<string, unknown> = {}) {
			for (const handler of extension.handlers.get(name) ?? []) await (handler as (event: Record<string, unknown>, ctx: unknown) => Promise<void>)({ type: name, ...event }, ctx);
		},
	};
}

export async function startSetup(harness: HarnessReturn, intent = "redesign the goal mode"): Promise<SetupData> {
	await harness.command.handler(intent, harness.ctx);
	return latestGoalEntry(harness).data.setup;
}

export async function activateGoal(
	harness: HarnessReturn,
	intent = "redesign the goal mode",
	objective = RICH_OBJECTIVE,
): Promise<{ setup: SetupData; result: { content: { type: string; text: string }[]; details?: unknown }; goal: GoalData | null }> {
	const setup = await startSetup(harness, intent);
	const goalPresentTool = harness.tool("goal_present")!;
	const presentResult = await goalPresentTool.execute("call-present", { objective }, undefined, undefined, harness.ctx);
	assert.ok(presentResult, "goal_present should succeed");
	appendUserApproval(harness);
	harness.sentMessages.length = 0;
	const result = await harness.tool("goal_set")!.execute("call-set", { confirmed: true, objective }, undefined, undefined, harness.ctx);
	return { setup, result, goal: latestGoalEntry(harness).data.goal };
}

export function appendAssistantContractSummary(harness: HarnessReturn, content = RICH_OBJECTIVE) {
	const entry = { type: "message", message: { role: "assistant" as const, content } };
	harness.entries.push(entry);
	return entry;
}

export function appendAssistantContractSummaryParts(harness: HarnessReturn, content = RICH_OBJECTIVE) {
	const entry = { type: "message", message: { role: "assistant" as const, content: [{ type: "message" as const, content: [{ type: "text" as const, text: content }] }] } };
	harness.entries.push(entry);
	return entry;
}

export function appendUserApproval(harness: HarnessReturn, content = "approved") {
	const entry = { type: "message", message: { role: "user" as const, content } };
	harness.entries.push(entry);
	return entry;
}

export function latestGoalEntry(harness: HarnessReturn): { data: { goal: GoalData | null; setup: SetupData | null } } {
	const entry = harness.entries.toReversed().find((candidate) => (candidate as { customType?: string }).customType === "pi-goal-state") as { data: { goal: unknown; setup: unknown } };
	assert.ok(entry, "event=goal_extension.persist actor=extension operation=find_goal_state risk=lost_goal_state expected=custom goal state entry actual=none suggestion=inspect persistState");
	return entry as { data: { goal: GoalData | null; setup: SetupData | null } };
}

export function goalEntry(overrides: Record<string, unknown> = {}) {
	const timestamp = "2026-05-01T00:00:00.000Z";
	return {
		type: "custom" as const,
		customType: "pi-goal-state" as const,
		data: {
			version: 1,
			setup: (overrides.setup as unknown) ?? null,
			goal: overrides.goal ?? {
				id: (overrides.id as string) ?? "goal-test-id",
				generation: (overrides.generation as number) ?? 1,
				objective: (overrides.objective as string) ?? RICH_OBJECTIVE,
				status: (overrides.status as string) ?? "active",
				tokenBudget: (overrides.tokenBudget as number | null) ?? null,
				tokensUsed: (overrides.tokensUsed as number) ?? 0,
				timeUsedSeconds: (overrides.timeUsedSeconds as number) ?? 0,
				createdAt: (overrides.createdAt as string) ?? timestamp,
				updatedAt: (overrides.updatedAt as string) ?? timestamp,
				continuationSuppressed: (overrides.continuationSuppressed as boolean) ?? false,
				lastContinuationTurnHadNoTools: (overrides.lastContinuationTurnHadNoTools as boolean) ?? false,
				statusLine: (overrides.statusLine as string) ?? "working from branch state",
				blockedReason: (overrides.blockedReason as string | null) ?? null,
			},
		},
	};
}

export function terminalSvg(plainText: string): string {
	const lines = plainText.split("\n");
	const width = Math.max(...lines.map((line) => line.length), 1) * 9 + 48;
	const height = lines.length * 18 + 48;
	const rows = lines.map((line, index) => `<text x="24" y="${34 + index * 18}">${escapeXml(line)}</text>`).join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#050300"/>
<g font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="14" fill="#ffb000" xml:space="preserve">
${rows}
</g>
</svg>
`;
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function plain(value: string): string {
	return stripVTControlCharacters(value ?? "");
}

export function parseToolResponse(response: { content: { type: string; text: string }[] }): Record<string, unknown> {
	return JSON.parse(response.content[0].text);
}
