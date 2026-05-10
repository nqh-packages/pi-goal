import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { STATUS_LINE } from "./messages.js";
import { GOAL_ENTRY_TYPE, type BlockedReason, type GoalEntry, type GoalSetupState, type GoalState, type GoalStatus, type SetupPhase } from "./types.js";

const GOAL_STATUSES = new Set<GoalStatus>(["active", "paused", "budget_limited", "complete"]);
const SETUP_PHASES = new Set<SetupPhase>(["interviewing", "cancelled"]);
const BLOCKED_REASONS = new Set<Exclude<BlockedReason, null>>(["no_work", "budget", "waiting_on_user"]);
const REQUIRED_OBJECTIVE_LABELS = ["Outcome:", "Done criteria:", "MUST DO:", "AVOID:", "Decision philosophy:", "Ask-before boundaries:"];

export const nowIso = (): string => new Date().toISOString();

export const newSetup = (intent: string, tokenBudget: number | null, generation: number): GoalSetupState => {
	const timestamp = nowIso();
	return {
		id: randomUUID(),
		generation,
		intent,
		tokenBudget,
		phase: "interviewing",
		contractPresentedAt: null,
		contractObjective: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
};

export const cancelSetup = (setup: GoalSetupState): GoalSetupState => {
	setup.phase = "cancelled";
	setup.updatedAt = nowIso();
	return setup;
};

export const newGoal = (objective: string, tokenBudget: number | null, generation: number): GoalState => {
	const timestamp = nowIso();
	return {
		id: randomUUID(),
		generation,
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		continuationSuppressed: false,
		lastContinuationTurnHadNoTools: false,
		statusLine: STATUS_LINE.STARTING,
		blockedReason: null,
	};
};

export const sanitizeObjective = (value: string): string => value.trim();

export const validateIntent = (intent: string): string | null => {
	if (!intent) return "Goal intent must not be empty.";
	if (intent.length > 1000) return "Goal intent must be 1000 characters or fewer.";
	return null;
};

export const validateObjective = (objective: string): string | null => {
	if (!objective) return "Goal objective must not be empty.";
	if (objective.length > 4000) return "Goal objective must be 4000 characters or fewer.";
	for (const label of REQUIRED_OBJECTIVE_LABELS) {
		if (!objective.includes(label)) return `Goal objective must include a ${label} section.`;
	}
	return null;
};

export const validateProgressText = (text: string): string | null => {
	const trimmed = text.trim();
	if (!trimmed) return "Goal status line text must not be empty.";
	if (trimmed.length > 64) return "Goal status line text must be 64 characters or fewer.";
	if (/\r|\n/.test(trimmed)) return "Goal status line text must be a single line.";
	if (/[^\t\x20-\x7E\u00A0-\uFFFF]/u.test(trimmed)) return "Goal status line text must not contain control characters.";
	return null;
};

export const validateTokenBudget = (value: number | null): string | null => {
	if (value === null) return null;
	if (!Number.isInteger(value) || value <= 0) return "Goal token budget must be a positive integer.";
	return null;
};

export const completeGoal = (goal: GoalState): GoalState => {
	goal.status = "complete";
	goal.continuationSuppressed = true;
	goal.lastContinuationTurnHadNoTools = false;
	goal.blockedReason = null;
	goal.statusLine = STATUS_LINE.GOAL_COMPLETE;
	goal.updatedAt = nowIso();
	return goal;
};

export const applyBudgetLimit = (goal: GoalState): boolean => {
	if (goal.status !== "active" || goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget) {
		return false;
	}
	goal.status = "budget_limited";
	goal.blockedReason = "budget";
	goal.continuationSuppressed = true;
	goal.statusLine = STATUS_LINE.BUDGET_LIMIT;
	goal.updatedAt = nowIso();
	return true;
};

export const addAssistantTurnUsage = (goal: GoalState, message: AgentMessage): boolean => {
	if (goal.status !== "active" || message.role !== "assistant") return false;
	const tokens = assistantUsageTokens(message);
	if (tokens <= 0) return false;
	goal.tokensUsed += tokens;
	goal.updatedAt = nowIso();
	return true;
};

export const decodeGoalEntry = (entry: unknown): GoalEntry | null => {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) return null;
	const data = entry.data;
	if (!isRecord(data) || data.version !== 1) return null;
	const goal = data.goal === null || data.goal === undefined ? null : isGoalState(data.goal) ? data.goal : undefined;
	if (goal === undefined) return null;
	const setup = data.setup === null || data.setup === undefined ? null : isGoalSetupState(data.setup) ? data.setup : undefined;
	if (setup === undefined) return null;
	return { version: 1, goal, setup };
};

export const latestGoalEntry = (entries: readonly unknown[]): GoalEntry | null => {
	for (const entry of [...entries].reverse()) {
		const decoded = decodeGoalEntry(entry);
		if (decoded) return decoded;
	}
	return null;
};

const assistantUsageTokens = (message: AgentMessage): number => {
	if (message.role !== "assistant") return 0;
	const usage = message.usage as Partial<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	}> | undefined;
	if (!usage) return 0;
	if (isNonNegativeInteger(usage.totalTokens)) return usage.totalTokens;
	const tokenParts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
	if (!tokenParts.every(isNonNegativeInteger)) return 0;
	return tokenParts.reduce((sum, value) => sum + value, 0);
};

const isGoalSetupState = (value: unknown): value is GoalSetupState => {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		isPositiveInteger(value.generation) &&
		typeof value.intent === "string" &&
		(value.tokenBudget === null || isPositiveInteger(value.tokenBudget)) &&
		isSetupPhase(value.phase) &&
		(value.contractPresentedAt === null || typeof value.contractPresentedAt === "string") &&
		(value.contractObjective === null || typeof value.contractObjective === "string") &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string"
	);
};

const isGoalState = (value: unknown): value is GoalState => {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		isPositiveInteger(value.generation) &&
		typeof value.objective === "string" &&
		isGoalStatus(value.status) &&
		(value.tokenBudget === null || isPositiveInteger(value.tokenBudget)) &&
		isNonNegativeInteger(value.tokensUsed) &&
		isNonNegativeInteger(value.timeUsedSeconds) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.continuationSuppressed === "boolean" &&
		typeof value.lastContinuationTurnHadNoTools === "boolean" &&
		typeof value.statusLine === "string" &&
		isBlockedReason(value.blockedReason)
	);
};

const isGoalStatus = (value: unknown): value is GoalStatus => typeof value === "string" && GOAL_STATUSES.has(value as GoalStatus);
const isSetupPhase = (value: unknown): value is SetupPhase => typeof value === "string" && SETUP_PHASES.has(value as SetupPhase);
const isBlockedReason = (value: unknown): value is BlockedReason => value === null || (typeof value === "string" && BLOCKED_REASONS.has(value as Exclude<BlockedReason, null>));

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && typeof value === "number" && value > 0;
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && typeof value === "number" && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
