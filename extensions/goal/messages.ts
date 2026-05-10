/**
 * Structured developer/agent-facing messages for the pi-goal extension.
 *
 * Follows write-dev-logs conventions:
 * - Tool responses → JSON with type/detail/context/suggestions
 * - UI notifications → typed category + actionable text
 * - Debug/audit events → structured with operation/reason/context
 * - Validation errors → stable error_code + detail + suggestion
 */

import type { GoalToolDetails } from "./types.js";

// ─── Tool Response Helpers ────────────────────────────────────────────

export interface ToolResponseMeta {
	type: string;
	title: string;
	status: "success" | "rejected";
	error_code: string | null;
	detail: string;
	context: Record<string, unknown>;
	suggestions: string[];
}

/**
 * Build a structured tool response for agent consumption.
 * The caller wraps this in the tool's content envelope.
 */
export function toolResponse(
	meta: ToolResponseMeta,
	details?: GoalToolDetails,
): { content: { type: "text"; text: string }[]; details?: GoalToolDetails } {
	const payload = {
		type: meta.type,
		status: meta.status,
		...(meta.error_code ? { error_code: meta.error_code } : {}),
		detail: meta.detail,
		...(meta.context && Object.keys(meta.context).length > 0 ? { context: meta.context } : {}),
		...(meta.suggestions.length > 0 ? { suggestions: meta.suggestions } : {}),
	};
	const result: { content: { type: "text"; text: string }[]; details?: GoalToolDetails } = {
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
	if (details) result.details = details;
	return result;
}

export function toolSuccessResponse(details: GoalToolDetails): { content: { type: "text"; text: string }[]; details?: GoalToolDetails } {
	const payload = {
		type: "https://pi.local/goal/success",
		status: "success",
		detail: "Tool executed successfully.",
		...(details ? { goal: details.goal, setup: details.setup, remainingTokens: details.remainingTokens, completionBudgetReport: details.completionBudgetReport } : {}),
	};
	const result: { content: { type: "text"; text: string }[]; details?: GoalToolDetails } = {
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
	if (details) result.details = details;
	return result;
}

// ─── Tool Response Message Constants ──────────────────────────────────

export const GOAL_SET_ERRORS = {
	NO_SETUP: {
		type: "https://pi.local/goal/error/no_setup",
		title: "No active setup",
		status: "rejected" as const,
		error_code: "GOAL_SET_NO_SETUP",
		detail: "goal_set requires an active /goal setup session.",
		context: {},
		suggestions: ["Run /goal <intent> to start a new setup session."],
	},
	NOT_CONFIRMED: {
		type: "https://pi.local/goal/error/not_confirmed",
		title: "Setup not confirmed",
		status: "rejected" as const,
		error_code: "GOAL_SET_NOT_CONFIRMED",
		detail: "The setup contract was not confirmed by the user.",
		context: {},
		suggestions: [
			"Wait for the user to respond with 'approved', 'yes', or an equivalent approval.",
			"Call goal_present first with the contract summary, then wait for the user to confirm.",
		],
	},
	NO_CONTRACT_PRESENTED: {
		type: "https://pi.local/goal/error/missing_contract",
		title: "Contract not presented",
		status: "rejected" as const,
		error_code: "GOAL_SET_NO_CONTRACT",
		detail: "The objective must match the contract presented via goal_present before activation.",
		context: {},
		suggestions: [
			"Call goal_present with the exact same objective string before calling goal_set.",
			"Ensure the objective contains all four required sections: Outcome:, Done criteria:, Decision philosophy:, Ask-before boundaries:.",
		],
	},
	BUDGET_OVERRIDE: (budget: number | null) => ({
		type: "https://pi.local/goal/error/budget_override",
		title: "Token budget override rejected",
		status: "rejected" as const,
		error_code: "GOAL_SET_BUDGET_OVERRIDE",
		detail: `goal_set cannot override the user setup token budget (${budget ?? "unlimited"}).`,
		context: { setup_token_budget: budget },
		suggestions: ["Omit token_budget from the goal_set call entirely."],
	}),
	ACTIVE_GOAL_EXISTS: {
		type: "https://pi.local/goal/error/active_goal",
		title: "Active goal already exists",
		status: "rejected" as const,
		error_code: "GOAL_SET_ACTIVE_GOAL",
		detail: "A goal is already active and must be completed or cancelled before a new one can start.",
		context: {},
		suggestions: ["Run /goal cancel to clear the active goal before starting a new setup."],
	},
} as const;

export const GOAL_STATUS_LINE_ERRORS = {
	NO_ACTIVE_GOAL: {
		type: "https://pi.local/goal/error/no_active_goal",
		title: "No active goal",
		status: "rejected" as const,
		error_code: "GOAL_STATUS_NO_GOAL",
		detail: "No active goal can receive status-line progress.",
		context: {},
		suggestions: ["Start a goal with /goal <intent> before calling goal_status_line."],
	},
	BLOCKED: (reason: string) => ({
		type: "https://pi.local/goal/error/blocked",
		title: "Goal is blocked",
		status: "rejected" as const,
		error_code: "GOAL_STATUS_BLOCKED",
		detail: `Goal status line cannot update while blocked (${reason}).`,
		context: { blocked_reason: reason },
		suggestions: ["Unblock the goal first (e.g., get user input for waiting_on_user, use /goal resume for no_work), then update the status line."],
	}),
};

export const GOAL_COMPLETE_ERRORS = {
	WRONG_STATUS: {
		type: "https://pi.local/goal/error/wrong_complete_status",
		title: "Invalid completion status",
		status: "rejected" as const,
		error_code: "GOAL_COMPLETE_STATUS",
		detail: "goal_complete can only set status to 'complete'.",
		context: {},
		suggestions: ['Call goal_complete with { status: "complete" } only.'],
	},
	NO_GOAL: {
		type: "https://pi.local/goal/error/no_goal",
		title: "No active goal",
		status: "rejected" as const,
		error_code: "GOAL_COMPLETE_NO_GOAL",
		detail: "No goal is currently set.",
		context: {},
		suggestions: ["Start a goal with /goal <intent> before calling goal_complete."],
	},
};

export const GOAL_PRESENT_ERRORS = {
	NO_SETUP: {
		type: "https://pi.local/goal/error/no_setup",
		title: "No active setup",
		status: "rejected" as const,
		error_code: "GOAL_PRESENT_NO_SETUP",
		detail: "No active goal setup found.",
		context: {},
		suggestions: ["Run /goal <intent> to start a setup session, then call goal_present with the contract summary."],
	},
};

// ─── Validation Message Constants ─────────────────────────────────────

export const VALIDATION_ERRORS = {
	EMPTY_INTENT: {
		type: "https://pi.local/goal/validation/empty_intent",
		title: "Empty goal intent",
		status: "rejected" as const,
		error_code: "VALIDATION_EMPTY_INTENT",
		detail: "Goal intent must not be empty.",
		context: {},
		suggestions: ["Provide a non-empty intent string: /goal <description of what to achieve>"],
	},
	LONG_INTENT: (length: number) => ({
		type: "https://pi.local/goal/validation/long_intent",
		title: "Goal intent too long",
		status: "rejected" as const,
		error_code: "VALIDATION_LONG_INTENT",
		detail: `Goal intent must be 1000 characters or fewer (received ${length}).`,
		context: { received_length: length, max_length: 1000 },
		suggestions: ["Shorten the intent to 1000 characters or fewer."],
	}),
	EMPTY_OBJECTIVE: {
		type: "https://pi.local/goal/validation/empty_objective",
		title: "Empty goal objective",
		status: "rejected" as const,
		error_code: "VALIDATION_EMPTY_OBJECTIVE",
		detail: "Goal objective must not be empty.",
		context: {},
		suggestions: ["Provide a rich objective containing Outcome:, Done criteria:, Decision philosophy:, and Ask-before boundaries: sections."],
	},
	LONG_OBJECTIVE: (length: number) => ({
		type: "https://pi.local/goal/validation/long_objective",
		title: "Goal objective too long",
		status: "rejected" as const,
		error_code: "VALIDATION_LONG_OBJECTIVE",
		detail: `Goal objective must be 4000 characters or fewer (received ${length}).`,
		context: { received_length: length, max_length: 4000 },
		suggestions: ["Shorten the objective to 4000 characters or fewer."],
	}),
	MISSING_OBJECTIVE_LABEL: (label: string) => ({
		type: "https://pi.local/goal/validation/missing_label",
		title: "Missing required objective section",
		status: "rejected" as const,
		error_code: "VALIDATION_MISSING_LABEL",
		detail: `Goal objective must include a "${label}" section.`,
		context: { missing_label: label, required_labels: ["Outcome:", "Done criteria:", "Decision philosophy:", "Ask-before boundaries:"] },
		suggestions: [`Add a "${label}" section to the objective string.`],
	}),
	EMPTY_PROGRESS: {
		type: "https://pi.local/goal/validation/empty_progress",
		title: "Empty status line text",
		status: "rejected" as const,
		error_code: "VALIDATION_EMPTY_PROGRESS",
		detail: "Goal status line text must not be empty.",
		context: {},
		suggestions: ["Provide a non-empty string describing current progress."],
	},
	LONG_PROGRESS: (length: number) => ({
		type: "https://pi.local/goal/validation/long_progress",
		title: "Status line too long",
		status: "rejected" as const,
		error_code: "VALIDATION_LONG_PROGRESS",
		detail: `Goal status line text must be 64 characters or fewer (received ${length}).`,
		context: { received_length: length, max_length: 64 },
		suggestions: ["Shorten the status line text to 64 characters or fewer."],
	}),
	MULTILINE_PROGRESS: {
		type: "https://pi.local/goal/validation/multiline_progress",
		title: "Multi-line status text",
		status: "rejected" as const,
		error_code: "VALIDATION_MULTILINE_PROGRESS",
		detail: "Goal status line text must be a single line.",
		context: {},
		suggestions: ["Remove line breaks from the status line text."],
	},
	CONTROL_CHAR_PROGRESS: {
		type: "https://pi.local/goal/validation/control_char_progress",
		title: "Control characters in status text",
		status: "rejected" as const,
		error_code: "VALIDATION_CONTROL_CHAR_PROGRESS",
		detail: "Goal status line text must not contain control characters.",
		context: {},
		suggestions: ["Remove or replace control characters (tabs, null bytes, etc.)."],
	},
	INVALID_TOKEN_BUDGET: (value: unknown) => ({
		type: "https://pi.local/goal/validation/invalid_budget",
		title: "Invalid token budget",
		status: "rejected" as const,
		error_code: "VALIDATION_TOKEN_BUDGET",
		detail: "Goal token budget must be a positive integer.",
		context: { received: value },
		suggestions: ["Provide a positive integer value for --token-budget."],
	}),
} as const;

// ─── UI Notification Message Constants ────────────────────────────────

export const NOTIFY = {
	NO_GOAL: { text: "No goal set. Try /goal <intent>", type: "info" as const },
	GOAL_CANCELLED: { text: "Goal cancelled", type: "info" as const },
	GOAL_PAUSED: { text: "Goal paused", type: "info" as const },
	GOAL_ACTIVE: { text: "Goal active", type: "info" as const },
	NO_PAUSE_TARGET: { text: "Nothing to pause", type: "warning" as const },
	NO_RESUME_TARGET: { text: "Nothing to resume", type: "warning" as const },
	WAITING_ON_USER: { text: "Answer needed before resuming", type: "warning" as const },
	BUDGET_LIMITED: { text: "Budget used. Complete it or cancel it", type: "warning" as const },
	ACTIVE_EXISTS: { text: "A goal is already active. Cancel it first", type: "warning" as const },
	NO_WORK_SUPPRESSED: { text: "No progress made. /goal resume to continue", type: "warning" as const },
	LEGACY_COMMAND: (name: string) => ({
		text: `Unsupported /goal command: ${name}. Try /goal help`,
		type: "warning" as const,
	}),
	SETUP_STARTED: { text: "Setup started. The assistant will walk through each contract phase for your approval.", type: "info" as const },
} as const;

// ─── Debug Event Name Constants ───────────────────────────────────────

export const EVENTS = {
	SETUP_STARTED: "goal.setup_started",
	GOAL_STARTED: "goal.started",
	GOAL_PRESENTED: "goal.present",
	GOAL_CANCELLED: "goal.cancelled",
	GOAL_PAUSED: "goal.paused",
	GOAL_RESUMED: "goal.resumed",
	GOAL_RESTORED: "goal.restored",
	GOAL_COMPLETED: "goal.complete",
	BUDGET_LIMITED: "goal.budget_limited",
	CONTINUATION_QUEUED: "goal.continuation_queued",
	CONTINUATION_SUPPRESSED: "goal.continuation_suppressed",
	SETUP_CHECK_FAIL: "goal_set.check_fail",
	AUDIT: "goal.audit",
} as const;

// ─── Status Line Text Constants ───────────────────────────────────────

export const STATUS_LINE = {
	STARTING: "starting goal",
	RESUMING: "resuming",
	ANSWER_NEEDED: "answer needed",
	NO_PROGRESS: "no progress",
	GOAL_COMPLETE: "goal complete",
	BUDGET_LIMIT: "budget limit reached",
} as const;

// ─── Audit Mutation Action Constants ──────────────────────────────────

export const AUDIT_ACTIONS = {
	SETUP_START: "goal.setup.start",
	GOAL_SET_SUCCESS: "goal.set",
	GOAL_CANCEL: "goal.cancel",
	GOAL_PAUSE: "goal.pause",
	GOAL_RESUME: "goal.resume",
	GOAL_COMPLETE: "goal.complete",
	GOAL_PRESENT: "goal.present",
} as const;

export const AUDIT_OUTCOMES = {
	SUCCESS: "success" as const,
	FAILURE: "failure" as const,
	DENIED: "denied" as const,
} as const;

// ─── Help Text ────────────────────────────────────────────────────────

export const HELP = [
	"/goal <intent> [--token-budget N]     start a new goal setup",
	"/goal status                          show current goal state",
	"/goal pause                           pause autonomous work",
	"/goal resume                          resume a blocked or paused goal",
	"/goal cancel                          cancel setup or active goal",
	"/goal help                            show this help",
	"",
	"The assistant guides you phase by phase: budget, outcome, done criteria, must do, avoid, decision philosophy, ask-before boundaries. Approve each section before moving to the next.",
].join("\n");

// ─── Setup Panel Text ─────────────────────────────────────────────────

export function setupPanel(setupId: string, intent: string, tokenBudget: number | null): string[] {
	return [
		"Goal setup in progress.",
		`Intent: ${intent}`,
		`Setup id: ${setupId}`,
		tokenBudget === null ? "Token budget: none" : `Token budget: ${tokenBudget}`,
		"Next: the assistant will ask about budget type first, then propose each contract section phase by phase for your approval.",
		"Commands: /goal status, /goal cancel, /goal help",
	];
}
