import type { GoalState } from "./types.js";

export const formatElapsed = (seconds: number): string => {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	if (safeSeconds < 60) return `${safeSeconds}s`;
	const minutes = Math.floor(safeSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return `${days}d ${remainingHours}h ${remainingMinutes}m`;
};

export const formatTokens = (tokens: number): string => {
	const abs = Math.abs(tokens);
	if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(tokens);
};

export const goalLabel = (goal: GoalState): string => {
	switch (goal.status) {
		case "active":
			return `Goal active ${goal.tokenBudget ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}` : formatElapsed(goal.timeUsedSeconds)}`;
		case "paused":
			return "Goal paused";
		case "budget_limited":
			return goal.tokenBudget
				? `Goal budget ${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`
				: "Goal budget limited";
		case "complete":
			return `Goal complete ${goal.tokenBudget ? `${formatTokens(goal.tokensUsed)} tokens` : formatElapsed(goal.timeUsedSeconds)}`;
	}
};

export const goalSummary = (goal: GoalState): string => {
	const parts = [`Objective: ${goal.objective}`, `Status: ${goal.status}`];
	if (goal.timeUsedSeconds > 0) parts.push(`Time: ${formatElapsed(goal.timeUsedSeconds)}`);
	if (goal.tokenBudget !== null) {
		parts.push(`Tokens: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`);
	}
	return parts.join(". ");
};

export const remainingTokens = (goal: GoalState): number | null => {
	if (goal.tokenBudget === null) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
};

export const completionBudgetReport = (goal: GoalState): string | null => {
	const parts: string[] = [];
	if (goal.tokenBudget !== null) {
		parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
	}
	if (goal.timeUsedSeconds > 0) {
		parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
	}
	if (parts.length === 0) return null;
	return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
};
