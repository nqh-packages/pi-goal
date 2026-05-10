import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_DEBUG_ENTRY_TYPE, GOAL_DEBUG_EVENT_TYPE, goalDebugEvent, latestGoalDebugEntry } from "./goal/debug.js";
import { completionBudgetReport, goalStatusLine, goalStatusPanel, remainingTokens, setupStatusLine } from "./goal/format.js";
import { budgetLimitPrompt, continuationPrompt, setupPrompt } from "./goal/prompts.js";
import { AUDIT_ACTIONS, AUDIT_OUTCOMES, EVENTS, GOAL_COMPLETE_ERRORS, GOAL_PRESENT_ERRORS, GOAL_SET_ERRORS, GOAL_STATUS_LINE_ERRORS, HELP, NOTIFY, STATUS_LINE, VALIDATION_ERRORS, setupPanel, toolResponse, toolSuccessResponse } from "./goal/messages.js";
import {
	addAssistantTurnUsage,
	applyBudgetLimit,
	completeGoal,
	latestGoalEntry,
	newGoal,
	newSetup,
	nowIso,
	sanitizeObjective,
	validateIntent,
	validateObjective,
	validateProgressText,
	validateTokenBudget,
} from "./goal/state.js";
import { GOAL_CONTEXT_TYPE, GOAL_CONTINUATION_TYPE, GOAL_ENTRY_TYPE, GOAL_SETUP_TYPE, STATUS_KEY, type BlockedReason, type GoalEntry, type GoalSetupState, type GoalState, type GoalToolDetails } from "./goal/types.js";

const GoalSetParams = Type.Object({
	confirmed: Type.Boolean(),
	objective: Type.String(),
});

const GoalStatusLineParams = Type.Object({
	text: Type.String(),
});

const GoalCompleteParams = Type.Object({
	status: StringEnum(["complete"] as const),
});

const STATUS_HEARTBEAT_MS = 500;

type GoalSetParams = {
	confirmed: boolean;
	objective: string;
	token_budget?: number | null;
};

type GoalStatusLineParams = {
	text: string;
};

type GoalCompleteParams = {
	status: "complete";
};

export default function goalExtension(pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let setup: GoalSetupState | null = null;
	let activeTurnStartedAt: number | null = null;
	let currentTurnToolCalls = 0;
	let lastTurnToolCalls = 0;
	let debugEnabled = false;
	let continuationTurnPending = false;
	let continuationTurnActive = false;
	let generation = 0;
	let frameIndex = 0;
	let clearDoneStatusOnAgentEnd = false;
	let lastAssistantAskedQuestion = false;
	let statusHeartbeat: ReturnType<typeof setInterval> | null = null;

	function persistState() {
		pi.appendEntry<GoalEntry>(GOAL_ENTRY_TYPE, {
			version: 1,
			goal,
			setup,
		});
	}

	function persistDebugMode() {
		pi.appendEntry(GOAL_DEBUG_ENTRY_TYPE, {
			version: 1,
			enabled: debugEnabled,
		});
	}

	function emitDebugEvent(event: string, message: string, operation: string, context?: Record<string, unknown>) {
		if (!debugEnabled) return;
		pi.appendEntry(GOAL_DEBUG_EVENT_TYPE, goalDebugEvent({ goal, event, message, operation, context }));
	}

	function auditGoalMutation(action: string, targetId: string | null, outcome: "success" | "failure" | "denied", reason?: string) {
		// evlog-compatible audit coverage: equivalent to log.audit({ actor, action, target, outcome, reason }).
		pi.appendEntry(GOAL_DEBUG_EVENT_TYPE, goalDebugEvent({
			goal,
			event: "goal.audit",
			message: "Goal mutation audit event",
			operation: "log.audit",
			context: {
				audit: {
					action,
					actor: { type: "agent", id: "pi-goal-extension" },
					target: { type: "pi-goal", id: targetId ?? "none" },
					outcome,
					reason,
				},
			},
		}));
	}

	function renderStatus(ctx: ExtensionContext, options: { fromHeartbeat?: boolean } = {}) {
		ctx.ui.setWidget(STATUS_KEY, undefined);
		if (goal) {
			ctx.ui.setStatus(STATUS_KEY, goalStatusLine(goal, frameIndex++));
			if (!options.fromHeartbeat) syncStatusHeartbeat(ctx);
			return;
		}
		stopStatusHeartbeat();
		if (setup && setup.phase !== "cancelled") {
			ctx.ui.setStatus(STATUS_KEY, setupStatusLine(setup));
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function syncStatusHeartbeat(ctx: ExtensionContext) {
		if (!goal || goal.status !== "active" || goal.blockedReason || goal.continuationSuppressed) {
			stopStatusHeartbeat();
			return;
		}
		if (statusHeartbeat) return;
		statusHeartbeat = setInterval(() => {
			if (!goal || goal.status !== "active" || goal.blockedReason || goal.continuationSuppressed) {
				stopStatusHeartbeat();
				return;
			}
			renderStatus(ctx, { fromHeartbeat: true });
		}, STATUS_HEARTBEAT_MS);
		statusHeartbeat.unref?.();
	}

	function stopStatusHeartbeat() {
		if (!statusHeartbeat) return;
		clearInterval(statusHeartbeat);
		statusHeartbeat = null;
	}

	function setState(nextGoal: GoalState | null, nextSetup: GoalSetupState | null, ctx?: ExtensionContext) {
		goal = nextGoal;
		setup = nextSetup;
		if (goal) goal.updatedAt = nowIso();
		if (setup) setup.updatedAt = nowIso();
		generation = Math.max(generation, goal?.generation ?? 0, setup?.generation ?? 0);
		persistState();
		if (ctx) renderStatus(ctx);
	}

	function accountElapsed(ctx?: ExtensionContext) {
		if (!goal || goal.status !== "active" || activeTurnStartedAt === null) return;
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeTurnStartedAt) / 1000));
		if (elapsedSeconds <= 0) return;
		goal.timeUsedSeconds += elapsedSeconds;
		goal.updatedAt = nowIso();
		activeTurnStartedAt = Date.now();
		applyBudgetLimit(goal);
		persistState();
		if (ctx) renderStatus(ctx);
	}

	function queueSetup(ctx: ExtensionContext, currentSetup: GoalSetupState) {
		if (ctx.hasPendingMessages()) return;
		pi.sendMessage(
			{
				customType: GOAL_SETUP_TYPE,
				content: setupPrompt(currentSetup),
				display: false,
				details: { setupId: currentSetup.id, generation: currentSetup.generation },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function queueContinuation(ctx: ExtensionContext, reason: "command" | "resume" | "agent_end") {
		if (!goal || goal.status !== "active") return;
		if (goal.blockedReason || goal.continuationSuppressed) return;
		if (continuationTurnPending) return;
		if (ctx.hasPendingMessages()) {
			markBlocked("waiting_on_user", "answer needed", ctx);
			return;
		}
		if (!ctx.isIdle() && reason !== "agent_end") return;

		continuationTurnPending = true;
		emitDebugEvent(EVENTS.CONTINUATION_QUEUED, "Goal continuation queued", "queue_continuation", { reason });
		pi.sendMessage(
			{
				customType: GOAL_CONTINUATION_TYPE,
				content: continuationPrompt(goal),
				display: false,
				details: { goalId: goal.id, generation: goal.generation, reason },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function markBlocked(reason: Exclude<BlockedReason, null>, statusLine: string, ctx?: ExtensionContext) {
		if (!goal || goal.status !== "active") return;
		goal.blockedReason = reason;
		goal.statusLine = statusLine;
		goal.continuationSuppressed = reason === "no_work";
		setState(goal, setup, ctx);
	}

	function parseGoalArgs(args: string): { intent: string; tokenBudget: number | null; error: string | null } {
		const trimmed = args.trim();
		const budgetMatch = trimmed.match(/\s+--token-budget\s+(\d+)\s*$/);
		const tokenBudget = budgetMatch ? Number.parseInt(budgetMatch[1] ?? "", 10) : null;
		const intent = sanitizeObjective(unquoteIntent(budgetMatch ? trimmed.slice(0, budgetMatch.index).trim() : trimmed));
		return {
			intent,
			tokenBudget,
			error: validateIntent(intent) ?? validateTokenBudget(tokenBudget),
		};
	}

	function unquoteIntent(value: string): string {
		const trimmed = value.trim();
		if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
		return trimmed;
	}

	function details(): GoalToolDetails {
		return {
			goal,
			setup,
			remainingTokens: goal ? remainingTokens(goal) : null,
			completionBudgetReport: goal && goal.status === "complete" ? completionBudgetReport(goal) : null,
		};
	}

	function detailsText(extra?: Record<string, unknown>): string {
		return JSON.stringify({ ...details(), ...extra }, null, 2);
	}

	function hasConfirmedContractAfterSetup(currentSetup: GoalSetupState, objective: string): boolean {
		// Explicit state check — no branch scanning.
		// Agent calls goal_present when presenting the contract (records timestamp + objective).
		// Agent calls goal_set with confirmed=true after user says "yes".
		if (!currentSetup.contractPresentedAt) {
			emitDebugEvent(EVENTS.SETUP_CHECK_FAIL, "contract not presented (goal_present not called)", "hasConfirmedContractAfterSetup", {});
			return false;
		}
		if (currentSetup.contractObjective !== objective) {
			emitDebugEvent(EVENTS.SETUP_CHECK_FAIL, "presented objective does not match goal_set objective", "hasConfirmedContractAfterSetup", {
				presented: currentSetup.contractObjective,
				requested: objective,
			});
			return false;
		}
		return true;
	}

	function isUserApprovalEntry(entry: unknown): boolean {
		if (entryRole(entry) !== "user") return false;
		const content = entryContent(entry).trim();
		if (/\b(not approved|not yet|hold off|wait|do not proceed|don't proceed|do not activate|don't activate|reject|rejected|denied|stop)\b/i.test(content)) return false;
		return /^(yes|sure|ok|okay|approved|approve|confirmed|confirm|y|proceed|do it|activate|looks good|lgtm)(?:\b|[.!])/i.test(content) || /\b(please proceed|looks good to me|approved,? proceed)\b/i.test(content);
	}

	function entryRole(entry: unknown): string | null {
		if (!isRecord(entry)) return null;
		if (typeof entry.role === "string") return entry.role;
		if (isRecord(entry.message) && typeof entry.message.role === "string") return entry.message.role;
		return null;
	}

	function entryContent(entry: unknown): string {
		if (!isRecord(entry)) return "";
		if ("content" in entry) return contentToText(entry.content);
		if (isRecord(entry.message) && "content" in entry.message) return contentToText(entry.message.content);
		return "";
	}

	function contentToText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
		if (!isRecord(content)) return "";
		const parts = [content.text, content.content, content.input_text, content.message]
			.map(contentToText)
			.filter(Boolean);
		return parts.join("\n");
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	function assistantIndicatesWaiting(message: TurnEndEvent["message"]): boolean {
		if (message.role !== "assistant") return false;
		const content = contentToText(message.content).trim();
		return /[?？]\s*$|\b(please confirm|approval needed|needs approval|reply with|choose one|which option|what should|confirm before|approve before)\b/i.test(content);
	}

	pi.registerCommand("goal", {
		description: "Set up, inspect, pause, resume, or cancel a long-running session goal",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = trimmed.toLowerCase();

			if (!trimmed || command === "status") {
				if (goal) {
					ctx.ui.notify(goalStatusPanel(goal, setup), "info");
				} else if (setup && setup.phase !== "cancelled") {
					ctx.ui.notify(setupPanel(setup.id, setup.intent, setup.tokenBudget).join("\n"), "info");
				} else {
					ctx.ui.notify(NOTIFY.NO_GOAL.text, NOTIFY.NO_GOAL.type);
				}
				renderStatus(ctx);
				return;
			}

			if (command === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}

			if (["clear", "complete", "done", "unpause", "debug", "debug on", "debug off", "debug status"].includes(command)) {
				ctx.ui.notify(NOTIFY.LEGACY_COMMAND(trimmed).text, NOTIFY.LEGACY_COMMAND(trimmed).type);
				return;
			}

			if (command === "cancel") {
				emitDebugEvent(EVENTS.GOAL_CANCELLED, "Goal cancelled by user command", "goal_command");
				auditGoalMutation(AUDIT_ACTIONS.GOAL_CANCEL, goal?.id ?? setup?.id ?? null, AUDIT_OUTCOMES.SUCCESS);
				goal = null;
				setup = null;
				continuationTurnPending = false;
				continuationTurnActive = false;
				clearDoneStatusOnAgentEnd = false;
				setState(null, null, ctx);
				ctx.ui.notify(NOTIFY.GOAL_CANCELLED.text, NOTIFY.GOAL_CANCELLED.type);
				return;
			}

			if (command === "pause") {
				if (!goal) {
					ctx.ui.notify(NOTIFY.NO_PAUSE_TARGET.text, NOTIFY.NO_PAUSE_TARGET.type);
					return;
				}
				accountElapsed(ctx);
				goal.status = "paused";
				goal.blockedReason = null;
				goal.continuationSuppressed = false;
				continuationTurnPending = false;
				continuationTurnActive = false;
				setState(goal, setup, ctx);
				emitDebugEvent(EVENTS.GOAL_PAUSED, "Goal paused by user command", "goal_command");
				auditGoalMutation(AUDIT_ACTIONS.GOAL_PAUSE, goal.id, AUDIT_OUTCOMES.SUCCESS);
				ctx.ui.notify(NOTIFY.GOAL_PAUSED.text, NOTIFY.GOAL_PAUSED.type);
				return;
			}

			if (command === "resume") {
				if (!goal) {
					ctx.ui.notify(NOTIFY.NO_RESUME_TARGET.text, NOTIFY.NO_RESUME_TARGET.type);
					return;
				}
				if (goal.blockedReason === "waiting_on_user") {
					ctx.ui.notify(NOTIFY.WAITING_ON_USER.text, NOTIFY.WAITING_ON_USER.type);
					renderStatus(ctx);
					return;
				}
				if (goal.status === "budget_limited") {
					ctx.ui.notify(NOTIFY.BUDGET_LIMITED.text, NOTIFY.BUDGET_LIMITED.type);
					renderStatus(ctx);
					return;
				}
				goal.status = "active";
				goal.blockedReason = null;
				goal.continuationSuppressed = false;
				goal.lastContinuationTurnHadNoTools = false;
				goal.statusLine = goal.statusLine || STATUS_LINE.RESUMING;
				setState(goal, setup, ctx);
				emitDebugEvent(EVENTS.GOAL_RESUMED, "Goal resumed by user command", "goal_command");
				auditGoalMutation(AUDIT_ACTIONS.GOAL_RESUME, goal.id, AUDIT_OUTCOMES.SUCCESS);
				ctx.ui.notify(NOTIFY.GOAL_ACTIVE.text, NOTIFY.GOAL_ACTIVE.type);
				queueContinuation(ctx, "command");
				return;
			}

			if (goal && goal.status !== "complete") {
				ctx.ui.notify(NOTIFY.ACTIVE_EXISTS.text, NOTIFY.ACTIVE_EXISTS.type);
				renderStatus(ctx);
				return;
			}

			const parsed = parseGoalArgs(trimmed);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const nextSetup = newSetup(parsed.intent, parsed.tokenBudget, generation + 1);
			setState(null, nextSetup, ctx);
			emitDebugEvent(EVENTS.SETUP_STARTED, "Goal setup started by user command", "goal_command", { tokenBudget: parsed.tokenBudget });
			auditGoalMutation(AUDIT_ACTIONS.SETUP_START, nextSetup.id, AUDIT_OUTCOMES.SUCCESS);
			ctx.ui.notify(NOTIFY.SETUP_STARTED.text, NOTIFY.SETUP_STARTED.type);
			queueSetup(ctx, nextSetup);
		},
	});

	pi.registerTool<typeof GoalSetParams, GoalToolDetails>({
		name: "goal_set",
		label: "Set Goal",
		description: "Activate the latest user-approved goal setup with one rich objective string. Do not pass token_budget; the runtime uses the user's /goal setup budget.",
		promptSnippet: "goal_set: activate a confirmed setup after the user approves the contract summary. Omit token_budget entirely.",
		parameters: GoalSetParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const objective = sanitizeObjective(params.objective);
			const tokenBudgetProvided = Object.hasOwn(params, "token_budget");
			const requestedTokenBudget = tokenBudgetProvided ? (params.token_budget ?? null) : (setup?.tokenBudget ?? null);
			const tokenBudget = setup?.tokenBudget ?? null;
			const validationError = validateObjective(objective) ?? validateTokenBudget(requestedTokenBudget);
			if (!setup || setup.phase === "cancelled") {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, null, AUDIT_OUTCOMES.DENIED, GOAL_SET_ERRORS.NO_SETUP.error_code);
				return toolResponse(GOAL_SET_ERRORS.NO_SETUP, details());
			}
			if (!params.confirmed) {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, setup.id, AUDIT_OUTCOMES.DENIED, GOAL_SET_ERRORS.NOT_CONFIRMED.error_code);
				return toolResponse(GOAL_SET_ERRORS.NOT_CONFIRMED, details());
			}
			if (validationError) {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, setup.id, AUDIT_OUTCOMES.DENIED, validationError);
				return toolResponse({
					type: "https://pi.local/goal/error/validation",
					title: "Validation error",
					status: "rejected",
					error_code: "GOAL_SET_VALIDATION",
					detail: validationError,
					context: {},
					suggestions: ["Check the objective format and required labels."],
				}, details());
			}
			if (!hasConfirmedContractAfterSetup(setup, objective)) {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, setup.id, AUDIT_OUTCOMES.DENIED, GOAL_SET_ERRORS.NO_CONTRACT_PRESENTED.error_code);
				return toolResponse(GOAL_SET_ERRORS.NO_CONTRACT_PRESENTED, details());
			}
			if (tokenBudgetProvided && requestedTokenBudget !== tokenBudget) {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, setup.id, AUDIT_OUTCOMES.DENIED, GOAL_SET_ERRORS.BUDGET_OVERRIDE(tokenBudget).error_code);
				return toolResponse(GOAL_SET_ERRORS.BUDGET_OVERRIDE(tokenBudget), details());
			}
			if (goal && goal.status !== "complete") {
				auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, goal.id, AUDIT_OUTCOMES.DENIED, GOAL_SET_ERRORS.ACTIVE_GOAL_EXISTS.error_code);
				return toolResponse(GOAL_SET_ERRORS.ACTIVE_GOAL_EXISTS, details());
			}
			const nextGoal = newGoal(objective, tokenBudget, setup.generation);
			setState(nextGoal, null, ctx);
			emitDebugEvent(EVENTS.GOAL_STARTED, "Goal activated from confirmed setup", "goal_set", { tokenBudget });
			auditGoalMutation(AUDIT_ACTIONS.GOAL_SET_SUCCESS, nextGoal.id, AUDIT_OUTCOMES.SUCCESS);
			queueContinuation(ctx, "command");
			return toolSuccessResponse(details());
		},
	});

	pi.registerTool({
		name: "goal_get",
		label: "Get Goal",
		description: "Get the current long-running session goal/setup state, including status, budget, elapsed time, and remaining token budget.",
		promptSnippet: "goal_get: inspect the current long-running session goal or setup state.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: detailsText() }], details: details() };
		},
	});

	pi.registerTool<typeof GoalStatusLineParams, GoalToolDetails>({
		name: "goal_status_line",
		label: "Update Goal Status Line",
		description: "Update short current-progress text for the active goal status line.",
		promptSnippet: "goal_status_line: update the short current-progress text shown in the status line.",
		parameters: GoalStatusLineParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!goal || goal.status !== "active") {
				return toolResponse(GOAL_STATUS_LINE_ERRORS.NO_ACTIVE_GOAL, details());
			}
			if (goal.blockedReason) {
				return toolResponse(GOAL_STATUS_LINE_ERRORS.BLOCKED(goal.blockedReason), details());
			}
			const text = params.text.trim();
			const validationError = validateProgressText(text);
			if (validationError) {
				return toolResponse({
					type: "https://pi.local/goal/error/validation",
					title: "Validation error",
					status: "rejected",
					error_code: "GOAL_STATUS_VALIDATION",
					detail: validationError,
					context: {},
					suggestions: ["Check the status line text format."],
				}, details());
			}
			goal.statusLine = text;
			setState(goal, setup, ctx);
			return { content: [{ type: "text", text: detailsText() }], details: details() };
		},
	});

	pi.registerTool<typeof GoalCompleteParams, GoalToolDetails>({
		name: "goal_complete",
		label: "Complete Goal",
		description: `Complete the existing long-running session goal.
Use this tool only when the objective has actually been achieved and no required work remains.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.`,
		promptSnippet: "goal_complete: mark the current long-running session goal complete when it is actually achieved.",
		parameters: GoalCompleteParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") {
				return toolResponse(GOAL_COMPLETE_ERRORS.WRONG_STATUS, details());
			}
			if (!goal) {
				return toolResponse(GOAL_COMPLETE_ERRORS.NO_GOAL, details());
			}
			accountElapsed(ctx);
			completeGoal(goal);
			setState(goal, setup, ctx);
			clearDoneStatusOnAgentEnd = true;
			auditGoalMutation(AUDIT_ACTIONS.GOAL_COMPLETE, goal.id, AUDIT_OUTCOMES.SUCCESS);
			const report = completionBudgetReport(goal);
			return toolSuccessResponse(details());
		},
	});

	const GoalPresentParams = Type.Object({
		objective: Type.String(),
	});

	pi.registerTool<typeof GoalPresentParams, GoalToolDetails>({
		name: "goal_present",
		label: "Present Goal Contract",
		description: "Call this tool when you present the contract summary (Outcome, Done criteria, Decision philosophy, Ask-before boundaries) to the user. Records that the contract was presented and what objective was shown.",
		promptSnippet: "Call goal_present with the full objective string right when you present the contract to the user.",
		parameters: GoalPresentParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!setup) {
				return toolResponse(GOAL_PRESENT_ERRORS.NO_SETUP, details());
			}
			const objective = sanitizeObjective(params.objective);
			const validationError = validateObjective(objective);
			if (validationError) {
				return toolResponse({
					type: "https://pi.local/goal/error/validation",
					title: "Validation error",
					status: "rejected",
					error_code: "GOAL_PRESENT_VALIDATION",
					detail: validationError,
					context: {},
					suggestions: ["Check the objective format and required labels."],
				}, details());
			}
			setup.contractPresentedAt = nowIso();
			setup.contractObjective = objective;
			emitDebugEvent(EVENTS.GOAL_PRESENTED, "Contract presented to user", "goal_present", { objectivePreview: objective.slice(0, 80) });
			auditGoalMutation(AUDIT_ACTIONS.GOAL_PRESENT, setup.id, AUDIT_OUTCOMES.SUCCESS);
			setState(goal, setup, ctx);
			return toolSuccessResponse(details());
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const latest = latestGoalEntry(branch);
		goal = latest?.goal ?? null;
		setup = latest?.setup ?? null;
		generation = Math.max(goal?.generation ?? 0, setup?.generation ?? 0);
		debugEnabled = latestGoalDebugEntry(branch)?.enabled ?? false;
		activeTurnStartedAt = null;
		currentTurnToolCalls = 0;
		lastTurnToolCalls = 0;
		continuationTurnPending = false;
		continuationTurnActive = false;
		clearDoneStatusOnAgentEnd = false;
		renderStatus(ctx);
		if (goal?.status === "paused" && event.reason === "resume") {
			goal.status = "active";
			goal.continuationSuppressed = false;
			setState(goal, setup, ctx);
		}
		if (goal?.status === "active" && (event.reason === "startup" || event.reason === "resume")) {
			emitDebugEvent(EVENTS.GOAL_RESTORED, "Active goal restored from session branch", "session_start", { reason: event.reason });
			queueMicrotask(() => queueContinuation(ctx, "resume"));
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentTurnToolCalls = 0;
		lastAssistantAskedQuestion = false;
		continuationTurnActive = continuationTurnPending;
		continuationTurnPending = false;
		if (goal?.status === "active") {
			if (goal.blockedReason === "waiting_on_user" && !ctx.hasPendingMessages()) {
				goal.blockedReason = null;
				goal.statusLine = "resuming";
			}
			activeTurnStartedAt = Date.now();
			renderStatus(ctx);
		}
	});

	pi.on("tool_execution_end", async () => {
		currentTurnToolCalls++;
		if (goal?.status === "active") {
			goal.continuationSuppressed = false;
			goal.lastContinuationTurnHadNoTools = false;
			if (goal.blockedReason === "no_work") goal.blockedReason = null;
		}
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		lastTurnToolCalls = currentTurnToolCalls;
		accountElapsed(ctx);
		if (!goal) return;
		lastAssistantAskedQuestion = assistantIndicatesWaiting(event.message);
		addAssistantTurnUsage(goal, event.message);
		if (applyBudgetLimit(goal)) {
			setState(goal, setup, ctx);
			emitDebugEvent(EVENTS.BUDGET_LIMITED, "Goal reached token budget", "turn_end", { tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget });
			pi.sendMessage(
				{
					customType: GOAL_CONTEXT_TYPE,
					content: budgetLimitPrompt(goal),
					display: false,
					details: { goalId: goal.id, generation: goal.generation },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (clearDoneStatusOnAgentEnd && goal?.status === "complete") {
			clearDoneStatusOnAgentEnd = false;
			setState(null, setup, ctx);
			return;
		}
		if (!goal || goal.status !== "active") return;
		if (ctx.hasPendingMessages()) {
			goal.blockedReason = "waiting_on_user";
			goal.statusLine = "answer needed";
			setState(goal, setup, ctx);
			return;
		}
		if (lastAssistantAskedQuestion) {
			goal.blockedReason = "waiting_on_user";
			goal.statusLine = "answer needed";
			setState(goal, setup, ctx);
			return;
		}
		if (continuationTurnActive && lastTurnToolCalls === 0) {
			goal.continuationSuppressed = true;
			goal.lastContinuationTurnHadNoTools = true;
			goal.blockedReason = "no_work";
			goal.statusLine = STATUS_LINE.NO_PROGRESS;
			setState(goal, setup, ctx);
			emitDebugEvent(EVENTS.CONTINUATION_SUPPRESSED, "Goal continuation paused after a no-tool automatic turn", "agent_end");
			ctx.ui.notify(NOTIFY.NO_WORK_SUPPRESSED.text, NOTIFY.NO_WORK_SUPPRESSED.type);
			return;
		}
		queueContinuation(ctx, "agent_end");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountElapsed(ctx);
		if (goal?.status === "active") {
			goal.status = "paused";
			setState(goal, setup, ctx);
		}
		stopStatusHeartbeat();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
	});
}
