import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { GOAL_ENTRY_TYPE, type GoalEntry, type GoalState, type GoalStatus } from "./types.js";

const GOAL_STATUSES = new Set<GoalStatus>(["active", "paused", "budget_limited", "complete"]);

export const nowIso = (): string => new Date().toISOString();

export const newGoal = (objective: string, tokenBudget: number | null): GoalState => {
	const timestamp = nowIso();
	return {
		id: randomUUID(),
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		continuationSuppressed: false,
		lastContinuationTurnHadNoTools: false,
	};
};

export const sanitizeObjective = (value: string): string => value.trim();

export const validateObjective = (objective: string): string | null => {
	if (!objective) return "Goal objective must not be empty.";
	if (objective.length > 4000) return "Goal objective must be 4000 characters or fewer.";
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
	goal.updatedAt = nowIso();
	return goal;
};

export const applyBudgetLimit = (goal: GoalState): boolean => {
	if (goal.status !== "active" || goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget) {
		return false;
	}
	goal.status = "budget_limited";
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
	if (data.goal === null) return { version: 1, goal: null };
	if (!isGoalState(data.goal)) return null;
	return { version: 1, goal: data.goal };
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

const isGoalState = (value: unknown): value is GoalState => {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.objective === "string" &&
		isGoalStatus(value.status) &&
		(value.tokenBudget === null || isPositiveInteger(value.tokenBudget)) &&
		isNonNegativeInteger(value.tokensUsed) &&
		isNonNegativeInteger(value.timeUsedSeconds) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.continuationSuppressed === "boolean" &&
		typeof value.lastContinuationTurnHadNoTools === "boolean"
	);
};

const isGoalStatus = (value: unknown): value is GoalStatus => {
	return typeof value === "string" && GOAL_STATUSES.has(value as GoalStatus);
};

const isPositiveInteger = (value: unknown): value is number => {
	return Number.isInteger(value) && typeof value === "number" && value > 0;
};

const isNonNegativeInteger = (value: unknown): value is number => {
	return Number.isInteger(value) && typeof value === "number" && value >= 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null;
};
