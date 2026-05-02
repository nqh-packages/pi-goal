import type { GoalSetupState, GoalState } from "./types.js";

const CLOCK_FRAMES = ["◴", "◷", "◶", "◵"] as const;
const MAX_STATUS_TEXT = 64;
const BOLD = "\u001b[1m";
const BOLD_RESET = "\u001b[22m";
const YELLOW = "\u001b[33m";
const COLOR_RESET = "\u001b[39m";

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

export const remainingTokens = (goal: GoalState): number | null => {
	if (goal.tokenBudget === null) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
};

export const completionBudgetReport = (goal: GoalState): string | null => {
	const parts: string[] = [];
	if (goal.tokenBudget !== null) parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
	if (goal.timeUsedSeconds > 0) parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
	if (parts.length === 0) return null;
	return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
};

export const setupStatusLine = (setup: GoalSetupState): string => statusChrome(`setup: ${truncateSingleLine(setup.intent, 44)}`);

export const goalStatusLine = (goal: GoalState, frameIndex = 0): string => {
	const progress = truncateSingleLine(goal.statusLine || fallbackProgress(goal), MAX_STATUS_TEXT);
	switch (goal.status) {
		case "active":
			if (goal.blockedReason === "waiting_on_user") return statusChrome(progress === "answer needed" ? "? answer needed" : `? answer needed: ${progress}`);
			if (goal.blockedReason === "no_work" || goal.continuationSuppressed) return statusChrome("BLOCKED! no progress — /goal resume");
			return statusChrome(`${yellow(CLOCK_FRAMES[frameIndex % CLOCK_FRAMES.length])} ${progress}`);
		case "paused":
			return statusChrome(`Ⅱ paused: ${progress}`);
		case "budget_limited":
			return statusChrome("BLOCKED! budget limit reached");
		case "complete":
			return statusChrome("✓ goal complete");
	}
};

export const goalStatusPanel = (goal: GoalState, setup: GoalSetupState | null = null): string => {
	const rows = [
		`Goal: ${statusLabel(goal)}`,
		`Objective: ${goal.objective}`,
		`Progress: ${goal.statusLine || fallbackProgress(goal)}`,
		`Time: ${formatElapsed(goal.timeUsedSeconds)}`,
	];
	if (goal.tokenBudget !== null) rows.push(`Tokens: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`);
	if (goal.blockedReason) rows.push(`Blocked reason: ${goal.blockedReason}`);
	if (setup) rows.push(`Setup: ${setup.phase} (${setup.id})`);
	rows.push("Commands: /goal status, /goal pause, /goal resume, /goal cancel, /goal help");
	return rows.join("\n");
};

export const setupStatusPanel = (setup: GoalSetupState): string =>
	[
		"Goal setup in progress.",
		`Intent: ${setup.intent}`,
		`Setup id: ${setup.id}`,
		setup.tokenBudget === null ? "Token budget: none" : `Token budget: ${setup.tokenBudget}`,
		"Next: answer the assistant's setup questions, then approve the contract summary.",
		"Commands: /goal status, /goal cancel, /goal help",
	].join("\n");

export const helpText = (): string =>
	[
		"/goal <intent> [--token-budget N]",
		"/goal status",
		"/goal pause",
		"/goal resume",
		"/goal cancel",
		"/goal help",
		"",
		"/goal <intent> starts setup first. The assistant must interview, summarize the contract, get your approval, then call goal_set.",
	].join("\n");

const statusLabel = (goal: GoalState): string => {
	switch (goal.status) {
		case "active":
			return goal.continuationSuppressed ? "blocked" : "working";
		case "paused":
			return "paused";
		case "budget_limited":
			return "budget-limited";
		case "complete":
			return "done";
	}
};

const fallbackProgress = (goal: GoalState): string => {
	if (goal.status === "budget_limited") return "budget limit reached";
	if (goal.status === "complete") return "done";
	return "working";
};

const statusChrome = (status: string): string => `${BOLD}/goal${BOLD_RESET} ◇ ${status}`;

const yellow = (value: string): string => `${YELLOW}${value}${COLOR_RESET}`;

const truncateSingleLine = (value: string, width: number): string => {
	const singleLine = value.replace(/[\r\n\t]+/g, " ").trim();
	if (singleLine.length <= width) return singleLine;
	if (width <= 1) return "…";
	return `${singleLine.slice(0, width - 1)}…`;
};
