import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_DEBUG_ENTRY_TYPE, GOAL_DEBUG_EVENT_TYPE, goalDebugEvent, latestGoalDebugEntry } from "./goal/debug.js";
import { completionBudgetReport, goalStatusLine, goalStatusPanel, helpText, remainingTokens, setupStatusLine, setupStatusPanel } from "./goal/format.js";
import { budgetLimitPrompt, continuationPrompt, setupPrompt } from "./goal/prompts.js";
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
	setup_id: Type.String(),
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
	setup_id: string;
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
		emitDebugEvent("goal.continuation_queued", "Goal continuation queued", "queue_continuation", { reason });
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
			emitDebugEvent("goal_set.check_fail", "contract not presented (goal_present not called)", "hasConfirmedContractAfterSetup", {});
			return false;
		}
		if (currentSetup.contractObjective !== objective) {
			emitDebugEvent("goal_set.check_fail", "presented objective does not match goal_set objective", "hasConfirmedContractAfterSetup", {
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
					ctx.ui.notify(setupStatusPanel(setup), "info");
				} else {
					ctx.ui.notify("No goal is currently set. Usage: /goal <intent>", "info");
				}
				renderStatus(ctx);
				return;
			}

			if (command === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			if (["clear", "complete", "done", "unpause", "debug", "debug on", "debug off", "debug status"].includes(command)) {
				ctx.ui.notify(`Unsupported /goal command: ${trimmed}. Use /goal help.`, "warning");
				return;
			}

			if (command === "cancel") {
				emitDebugEvent("goal.cancelled", "Goal cancelled by user command", "goal_command");
				auditGoalMutation("goal.cancel", goal?.id ?? setup?.id ?? null, "success");
				goal = null;
				setup = null;
				continuationTurnPending = false;
				continuationTurnActive = false;
				clearDoneStatusOnAgentEnd = false;
				setState(null, null, ctx);
				ctx.ui.notify("Goal cancelled", "info");
				return;
			}

			if (command === "pause") {
				if (!goal) {
					ctx.ui.notify("No active goal to pause.", "warning");
					return;
				}
				accountElapsed(ctx);
				goal.status = "paused";
				goal.blockedReason = null;
				goal.continuationSuppressed = false;
				continuationTurnPending = false;
				continuationTurnActive = false;
				setState(goal, setup, ctx);
				emitDebugEvent("goal.paused", "Goal paused by user command", "goal_command");
				auditGoalMutation("goal.pause", goal.id, "success");
				ctx.ui.notify("Goal paused", "info");
				return;
			}

			if (command === "resume") {
				if (!goal) {
					ctx.ui.notify("No active goal to resume.", "warning");
					return;
				}
				if (goal.blockedReason === "waiting_on_user") {
					ctx.ui.notify("Goal needs a user answer before it can resume.", "warning");
					renderStatus(ctx);
					return;
				}
				if (goal.status === "budget_limited") {
					ctx.ui.notify("Goal reached its token budget. Complete it if done or cancel it.", "warning");
					renderStatus(ctx);
					return;
				}
				goal.status = "active";
				goal.blockedReason = null;
				goal.continuationSuppressed = false;
				goal.lastContinuationTurnHadNoTools = false;
				goal.statusLine = goal.statusLine || "resuming";
				setState(goal, setup, ctx);
				emitDebugEvent("goal.resumed", "Goal resumed by user command", "goal_command");
				auditGoalMutation("goal.resume", goal.id, "success");
				ctx.ui.notify("Goal active", "info");
				queueContinuation(ctx, "command");
				return;
			}

			if (goal && goal.status !== "complete") {
				ctx.ui.notify("A goal is already active. Use /goal cancel before starting a new setup.", "warning");
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
			emitDebugEvent("goal.setup_started", "Goal setup started by user command", "goal_command", { tokenBudget: parsed.tokenBudget });
			auditGoalMutation("goal.setup.start", nextSetup.id, "success");
			ctx.ui.notify("Goal setup started. Answer the assistant's questions, approve the contract summary, then Pi can activate the goal.", "info");
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
				auditGoalMutation("goal.set", null, "denied", "missing_setup");
				return { content: [{ type: "text", text: "goal_set requires an active /goal setup." }], details: details() };
			}
			if (params.setup_id !== setup.id) {
				auditGoalMutation("goal.set", setup.id, "denied", "stale_setup_id");
				return { content: [{ type: "text", text: "goal_set setup_id is stale or does not match the latest setup." }], details: details() };
			}
			if (!params.confirmed) {
				auditGoalMutation("goal.set", setup.id, "denied", "not_confirmed");
				return { content: [{ type: "text", text: "goal_set requires confirmed=true after explicit user approval." }], details: details() };
			}
			if (validationError) {
				auditGoalMutation("goal.set", setup.id, "denied", validationError);
				return { content: [{ type: "text", text: validationError }], details: details() };
			}
			if (!hasConfirmedContractAfterSetup(setup, objective)) {
				auditGoalMutation("goal.set", setup.id, "denied", "missing_contract_summary_or_approval");
				return { content: [{ type: "text", text: "goal_set requires a contract presentation via goal_present with a matching objective before activation." }], details: details() };
			}
			if (tokenBudgetProvided && requestedTokenBudget !== tokenBudget) {
				auditGoalMutation("goal.set", setup.id, "denied", "token_budget_override");
				return { content: [{ type: "text", text: "goal_set cannot override the user setup token budget." }], details: details() };
			}
			if (goal && goal.status !== "complete") {
				auditGoalMutation("goal.set", goal.id, "denied", "active_goal_exists");
				return { content: [{ type: "text", text: "A goal is already active. The user must run /goal cancel first." }], details: details() };
			}
			const nextGoal = newGoal(objective, tokenBudget, setup.generation);
			setState(nextGoal, null, ctx);
			emitDebugEvent("goal.started", "Goal activated from confirmed setup", "goal_set", { tokenBudget });
			auditGoalMutation("goal.set", nextGoal.id, "success");
			queueContinuation(ctx, "command");
			return { content: [{ type: "text", text: detailsText() }], details: details() };
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
				return { content: [{ type: "text", text: "No active goal can receive status-line progress." }], details: details() };
			}
			if (goal.blockedReason) {
				return { content: [{ type: "text", text: `Goal status line cannot update while blocked (${goal.blockedReason}).` }], details: details() };
			}
			const text = params.text.trim();
			const validationError = validateProgressText(text);
			if (validationError) {
				return { content: [{ type: "text", text: validationError }], details: details() };
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
				return { content: [{ type: "text", text: "goal_complete can only set status to complete." }], details: details() };
			}
			if (!goal) {
				return { content: [{ type: "text", text: "No goal is currently set." }], details: details() };
			}
			accountElapsed(ctx);
			completeGoal(goal);
			setState(goal, setup, ctx);
			clearDoneStatusOnAgentEnd = true;
			auditGoalMutation("goal.complete", goal.id, "success");
			const report = completionBudgetReport(goal);
			return { content: [{ type: "text", text: detailsText({ completionBudgetReport: report }) }], details: details() };
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
				return { content: [{ type: "text", text: "No active goal setup. Run /goal first." }], details: details() };
			}
			const objective = sanitizeObjective(params.objective);
			const validationError = validateObjective(objective);
			if (validationError) {
				return { content: [{ type: "text", text: validationError }], details: details() };
			}
			setup.contractPresentedAt = nowIso();
			setup.contractObjective = objective;
			emitDebugEvent("goal.present", "Contract presented to user", "goal_present", { objectivePreview: objective.slice(0, 80) });
			auditGoalMutation("goal.present", setup.id, "success");
			setState(goal, setup, ctx);
			return { content: [{ type: "text", text: "Contract presentation recorded." }], details: details() };
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
			emitDebugEvent("goal.restored", "Active goal restored from session branch", "session_start", { reason: event.reason });
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
			emitDebugEvent("goal.budget_limited", "Goal reached token budget", "turn_end", { tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget });
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
			goal.statusLine = "no progress";
			setState(goal, setup, ctx);
			emitDebugEvent("goal.continuation_suppressed", "Goal continuation paused after a no-tool automatic turn", "agent_end");
			ctx.ui.notify("Goal continuation paused because the last automatic turn made no tool calls. Use /goal resume to continue.", "warning");
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
