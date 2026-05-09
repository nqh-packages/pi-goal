export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type SetupPhase = "interviewing" | "cancelled";
export type BlockedReason = "no_work" | "budget" | "waiting_on_user" | null;

export interface GoalSetupState {
	id: string;
	generation: number;
	intent: string;
	tokenBudget: number | null;
	phase: SetupPhase;
	contractPresentedAt: string | null;
	contractObjective: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface GoalState {
	id: string;
	generation: number;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: string;
	updatedAt: string;
	continuationSuppressed: boolean;
	lastContinuationTurnHadNoTools: boolean;
	statusLine: string;
	blockedReason: BlockedReason;
}

export interface GoalEntry {
	version: 1;
	goal: GoalState | null;
	setup: GoalSetupState | null;
}

export interface GoalToolDetails {
	goal: GoalState | null;
	setup: GoalSetupState | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export const GOAL_ENTRY_TYPE = "pi-goal-state";
export const GOAL_CONTEXT_TYPE = "pi-goal-context";
export const GOAL_CONTINUATION_TYPE = "pi-goal-continuation";
export const GOAL_SETUP_TYPE = "pi-goal-setup";
export const STATUS_KEY = "pi-goal";
