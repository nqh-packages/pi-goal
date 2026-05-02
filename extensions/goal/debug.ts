import type { GoalState } from "./types.js";

export const GOAL_DEBUG_ENTRY_TYPE = "pi-goal-debug";
export const GOAL_DEBUG_EVENT_TYPE = "pi-goal-debug-event";

export interface GoalDebugEntry {
	version: 1;
	enabled: boolean;
}

export interface GoalDebugEvent {
	timestamp: string;
	level: "debug";
	service: "pi-goal";
	event: string;
	message: string;
	context: {
		goalId: string | null;
		goalStatus: GoalState["status"] | null;
		operation: string;
		reason?: string;
		[key: string]: unknown;
	};
}

export const latestGoalDebugEntry = (entries: readonly unknown[]): GoalDebugEntry | null => {
	for (const entry of [...entries].reverse()) {
		const decoded = decodeGoalDebugEntry(entry);
		if (decoded) return decoded;
	}
	return null;
};

export const goalDebugEvent = (args: {
	goal: GoalState | null;
	event: string;
	message: string;
	operation: string;
	reason?: string;
	context?: Record<string, unknown>;
}): GoalDebugEvent => {
	return {
		timestamp: new Date().toISOString(),
		level: "debug",
		service: "pi-goal",
		event: args.event,
		message: args.message,
		context: {
			goalId: args.goal?.id ?? null,
			goalStatus: args.goal?.status ?? null,
			operation: args.operation,
			...(args.reason === undefined ? {} : { reason: args.reason }),
			...(args.context ?? {}),
		},
	};
};

const decodeGoalDebugEntry = (entry: unknown): GoalDebugEntry | null => {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_DEBUG_ENTRY_TYPE) return null;
	const data = entry.data;
	if (!isRecord(data) || data.version !== 1 || typeof data.enabled !== "boolean") return null;
	return { version: 1, enabled: data.enabled };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null;
};
