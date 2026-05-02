import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_DEBUG_ENTRY_TYPE, GOAL_DEBUG_EVENT_TYPE, goalDebugEvent, latestGoalDebugEntry } from "./goal/debug.js";
import { completionBudgetReport, goalLabel, goalSummary, remainingTokens } from "./goal/format.js";
import { budgetLimitPrompt, continuationPrompt } from "./goal/prompts.js";
import {
	addAssistantTurnUsage,
	applyBudgetLimit,
	completeGoal,
	latestGoalEntry,
	newGoal,
	nowIso,
	sanitizeObjective,
	validateObjective,
	validateTokenBudget,
} from "./goal/state.js";
import { GOAL_CONTEXT_TYPE, GOAL_CONTINUATION_TYPE, GOAL_ENTRY_TYPE, STATUS_KEY, type GoalEntry, type GoalState, type UpdateGoalDetails } from "./goal/types.js";

const UpdateGoalParams = Type.Object({
	status: StringEnum(["complete"] as const),
});

export default function goalExtension(pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let activeTurnStartedAt: number | null = null;
	let currentTurnToolCalls = 0;
	let lastTurnToolCalls = 0;
	let debugEnabled = false;
	let continuationTurnPending = false;
	let continuationTurnActive = false;

	function persistGoal() {
		pi.appendEntry<GoalEntry>(GOAL_ENTRY_TYPE, {
			version: 1,
			goal,
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

	function updateStatus(ctx: ExtensionContext) {
		if (!goal) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(goal.status === "active" ? "accent" : "muted", goalLabel(goal)));
		if (goal.status === "active" || goal.status === "budget_limited" || goal.status === "paused") {
			ctx.ui.setWidget(STATUS_KEY, [goalSummary(goal)], { placement: "belowEditor" });
		} else {
			ctx.ui.setWidget(STATUS_KEY, undefined);
		}
	}

	function setGoal(nextGoal: GoalState | null, ctx?: ExtensionContext) {
		goal = nextGoal;
		if (goal) goal.updatedAt = nowIso();
		persistGoal();
		if (ctx) updateStatus(ctx);
	}

	function accountElapsed(ctx?: ExtensionContext) {
		if (!goal || goal.status !== "active" || activeTurnStartedAt === null) return;
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeTurnStartedAt) / 1000));
		if (elapsedSeconds <= 0) return;
		goal.timeUsedSeconds += elapsedSeconds;
		goal.updatedAt = nowIso();
		activeTurnStartedAt = Date.now();
		applyBudgetLimit(goal);
		persistGoal();
		if (ctx) updateStatus(ctx);
	}

	function queueContinuation(ctx: ExtensionContext, reason: "command" | "resume" | "agent_end") {
		if (!goal || goal.status !== "active") return;
		if (goal.continuationSuppressed) return;
		if (continuationTurnPending) return;
		if (ctx.hasPendingMessages()) return;
		if (!ctx.isIdle() && reason !== "agent_end") return;

		continuationTurnPending = true;
		emitDebugEvent("goal.continuation_queued", "Goal continuation queued", "queue_continuation", { reason });
		pi.sendMessage(
			{
				customType: GOAL_CONTINUATION_TYPE,
				content: continuationPrompt(goal),
				display: false,
				details: { goalId: goal.id, reason },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function parseGoalArgs(args: string): { objective: string; tokenBudget: number | null; error: string | null } {
		const trimmed = args.trim();
		const budgetMatch = trimmed.match(/\s+--token-budget\s+(\d+)\s*$/);
		const tokenBudget = budgetMatch ? Number.parseInt(budgetMatch[1] ?? "", 10) : null;
		const objective = sanitizeObjective(budgetMatch ? trimmed.slice(0, budgetMatch.index).trim() : trimmed);
		return {
			objective,
			tokenBudget,
			error: validateObjective(objective) ?? validateTokenBudget(tokenBudget),
		};
	}

	async function clarifyObjectiveIfNeeded(objective: string, ctx: ExtensionContext): Promise<string | null> {
		if (!isVagueObjective(objective)) return objective;
		const clarified = await ctx.ui.input(
			"Clarify goal",
			"This goal is too vague for autonomous continuation. What concrete outcome should pi pursue?",
		);
		const sanitized = sanitizeObjective(clarified ?? "");
		if (!sanitized) return null;
		return sanitized;
	}

	function isVagueObjective(objective: string): boolean {
		const words = objective.split(/\s+/).filter(Boolean);
		if (words.length >= 3) return false;
		return /^(fix|improve|polish|clean|refactor|debug|ship|finish|continue|work)$/i.test(objective);
	}

	pi.registerCommand("goal", {
		description: "Create, inspect, pause, resume, complete, or clear a long-running session goal",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set. Usage: /goal <objective>", "info");
					return;
				}
				ctx.ui.notify(goalSummary(goal), "info");
				updateStatus(ctx);
				return;
			}

			if (trimmed === "help") {
				ctx.ui.notify("/goal <objective> [--token-budget N]\n/goal status\n/goal pause\n/goal resume\n/goal complete\n/goal clear\n/goal debug [on|off|status]", "info");
				return;
			}

			if (trimmed === "debug" || trimmed === "debug status") {
				ctx.ui.notify(`Goal debug mode: ${debugEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (trimmed === "debug on") {
				debugEnabled = true;
				persistDebugMode();
				ctx.ui.notify("Goal debug mode: on", "info");
				return;
			}

			if (trimmed === "debug off") {
				debugEnabled = false;
				persistDebugMode();
				ctx.ui.notify("Goal debug mode: off", "info");
				return;
			}

			if (trimmed === "clear") {
				emitDebugEvent("goal.cleared", "Goal cleared by user command", "goal_command");
				setGoal(null, ctx);
				continuationTurnPending = false;
				continuationTurnActive = false;
				ctx.ui.notify("Goal cleared", "info");
				return;
			}

			if (trimmed === "pause") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set.", "warning");
					return;
				}
				accountElapsed(ctx);
				goal.status = "paused";
				goal.continuationSuppressed = false;
				setGoal(goal, ctx);
				emitDebugEvent("goal.paused", "Goal paused by user command", "goal_command");
				ctx.ui.notify("Goal paused", "info");
				return;
			}

			if (trimmed === "resume" || trimmed === "unpause") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set.", "warning");
					return;
				}
				goal.status = "active";
				goal.continuationSuppressed = false;
				goal.lastContinuationTurnHadNoTools = false;
				setGoal(goal, ctx);
				emitDebugEvent("goal.resumed", "Goal resumed by user command", "goal_command");
				ctx.ui.notify("Goal active", "info");
				queueContinuation(ctx, "command");
				return;
			}

			if (trimmed === "done" || trimmed === "complete") {
				if (!goal) {
					ctx.ui.notify("No goal is currently set.", "warning");
					return;
				}
				accountElapsed(ctx);
				completeGoal(goal);
				setGoal(goal, ctx);
				emitDebugEvent("goal.completed", "Goal completed by user command", "goal_command");
				ctx.ui.notify(completionBudgetReport(goal) ?? "Goal complete", "info");
				return;
			}

			const parsed = parseGoalArgs(trimmed);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const clarifiedObjective = await clarifyObjectiveIfNeeded(parsed.objective, ctx);
			if (!clarifiedObjective) return;
			if (goal && goal.status !== "complete") {
				const replace = await ctx.ui.confirm("Replace goal?", `Current: ${goal.objective}\n\nNew: ${clarifiedObjective}`);
				if (!replace) return;
			}
			setGoal(newGoal(clarifiedObjective, parsed.tokenBudget), ctx);
			emitDebugEvent("goal.started", "Goal started by user command", "goal_command", { tokenBudget: parsed.tokenBudget });
			ctx.ui.notify("Goal active", "info");
			queueContinuation(ctx, "command");
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current long-running session goal, including status, budget, elapsed time, and remaining token budget.",
		promptSnippet: "get_goal: inspect the current long-running session goal.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								goal,
								remainingTokens: goal ? remainingTokens(goal) : null,
							},
							null,
							2,
						),
					},
				],
				details: { goal, remainingTokens: goal ? remainingTokens(goal) : null },
			};
		},
	});

	pi.registerTool<typeof UpdateGoalParams, UpdateGoalDetails>({
		name: "update_goal",
		label: "Update Goal",
		description: `Update the existing long-running session goal.
Use this tool only to mark the goal achieved.
Set status to complete only when the objective has actually been achieved and no required work remains.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or runtime.`,
		promptSnippet: "update_goal: mark the current long-running session goal complete when it is actually achieved.",
		parameters: UpdateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") {
				return {
					content: [{ type: "text", text: "update_goal can only set status to complete." }],
					details: { goal, remainingTokens: goal ? remainingTokens(goal) : null, completionBudgetReport: null },
				};
			}
			if (!goal) {
				return {
					content: [{ type: "text", text: "No goal is currently set." }],
					details: { goal: null, remainingTokens: null, completionBudgetReport: null },
				};
			}
			accountElapsed(ctx);
			completeGoal(goal);
			setGoal(goal, ctx);
			const report = completionBudgetReport(goal);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								goal,
								remainingTokens: remainingTokens(goal),
								completionBudgetReport: report,
							},
							null,
							2,
						),
					},
				],
				details: { goal, remainingTokens: remainingTokens(goal), completionBudgetReport: report },
			};
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const latest = latestGoalEntry(branch);
		goal = latest?.goal ?? null;
		debugEnabled = latestGoalDebugEntry(branch)?.enabled ?? false;
		activeTurnStartedAt = null;
		currentTurnToolCalls = 0;
		lastTurnToolCalls = 0;
		continuationTurnPending = false;
		continuationTurnActive = false;
		updateStatus(ctx);
		if (goal?.status === "paused" && event.reason === "resume") {
			goal.status = "active";
			goal.continuationSuppressed = false;
			setGoal(goal, ctx);
		}
		if (goal?.status === "active" && (event.reason === "startup" || event.reason === "resume")) {
			emitDebugEvent("goal.restored", "Active goal restored from session branch", "session_start", { reason: event.reason });
			queueMicrotask(() => queueContinuation(ctx, "resume"));
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		currentTurnToolCalls = 0;
		continuationTurnActive = continuationTurnPending;
		continuationTurnPending = false;
		if (goal?.status === "active") {
			activeTurnStartedAt = Date.now();
			updateStatus(ctx);
		}
	});

	pi.on("tool_execution_end", async () => {
		currentTurnToolCalls++;
		if (goal?.status === "active") {
			goal.continuationSuppressed = false;
			goal.lastContinuationTurnHadNoTools = false;
		}
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		lastTurnToolCalls = currentTurnToolCalls;
		accountElapsed(ctx);
		if (!goal) return;
		addAssistantTurnUsage(goal, event.message);
		if (applyBudgetLimit(goal)) {
			setGoal(goal, ctx);
			emitDebugEvent("goal.budget_limited", "Goal reached token budget", "turn_end", { tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget });
			pi.sendMessage(
				{
					customType: GOAL_CONTEXT_TYPE,
					content: budgetLimitPrompt(goal),
					display: false,
					details: { goalId: goal.id },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!goal || goal.status !== "active") return;
		if (continuationTurnActive && lastTurnToolCalls === 0) {
			goal.continuationSuppressed = true;
			goal.lastContinuationTurnHadNoTools = true;
			setGoal(goal, ctx);
			emitDebugEvent("goal.continuation_suppressed", "Goal continuation paused after a no-tool automatic turn", "agent_end");
			ctx.ui.notify(
				"Goal continuation paused because the last automatic turn made no tool calls. Use /goal resume to continue.",
				"warning",
			);
			return;
		}
		queueContinuation(ctx, "agent_end");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountElapsed(ctx);
		if (goal?.status === "active") {
			goal.status = "paused";
			setGoal(goal, ctx);
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
	});
}
