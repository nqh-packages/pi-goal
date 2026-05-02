export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: string;
	updatedAt: string;
	continuationSuppressed: boolean;
	lastContinuationTurnHadNoTools: boolean;
}

export interface GoalEntry {
	version: 1;
	goal: GoalState | null;
}

export interface UpdateGoalDetails {
	goal: GoalState | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export const GOAL_ENTRY_TYPE = "pi-goal-state";
export const GOAL_CONTEXT_TYPE = "pi-goal-context";
export const GOAL_CONTINUATION_TYPE = "pi-goal-continuation";
export const STATUS_KEY = "pi-goal";
