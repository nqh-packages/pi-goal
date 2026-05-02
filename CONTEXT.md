# Pi Goal Extension

Product language for the `@qhn/pi-goal` terminal experience.

## Language

**Status Line**:
The primary user-facing surface for keeping people updated about goal mode.
_Avoid_: peripheral footer text, decorative status

**Autonomy Signal**:
The right-side indicator inside the **Status Line** showing whether Pi is still pursuing the active goal without user intervention.
_Avoid_: decoration, amber theme

**Working**:
Pi is allowed to continue the goal autonomously when the session is idle; its visual signal uses clock-hand animation frames `◴ ◷ ◶ ◵`.
_Avoid_: active, running, static dot

**Paused**:
The user intentionally stopped autonomous continuation without clearing the goal; its visual signal uses pause bars `Ⅱ`.
_Avoid_: inactive, suspended, blocked

**Blocked**:
Pi stopped autonomous continuation because continuing would be unsafe or useless without intervention; its visual signal must include the word `BLOCKED!`.
_Avoid_: failed, paused, errored

**Done**:
The goal has been explicitly completed after evidence review through `goal_complete`; its visual signal should appear briefly, then disappear from persistent UI.
_Avoid_: finished text, sentinel, persistent completed widget

**Agent Tool Grammar**:
The minimal tool surface agents use for goal state and progress: `goal_set`, `goal_get`, `goal_status_line`, and `goal_complete`.
_Avoid_: update_goal, set_goal_status, set_goal_title, structured contract tools

**Human Goal Command**:
The user-facing `/goal` command grammar: `/goal <intent>`, `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal help`.
_Avoid_: /goal clear, agent-only command verbs, legacy aliases

## Relationships

- A **Goal** has exactly one **Autonomy Signal** state.
- **Working**, **Paused**, **Blocked**, and **Done** are the canonical user-visible autonomy states.
- The **Status Line** is the core feature for staying updated during goal mode.
- The agent updates the **Status Line** during execution through `goal_status_line` with short current-progress text only.
- Persistent UI is one **Status Line** row showing current progress, with the **Autonomy Signal** as the live indicator.
- Goal mode does not show a title in persistent UI; the status line answers what is happening now.
- `/goal <intent>` always starts setup mode and never activates a goal directly.
- Before a goal becomes active, Pi runs a mandatory but adaptive setup interview to resolve outcome, done criteria, decision philosophy, and ask-before boundaries.
- Simple goals get a quick confirmation; ambiguous or high-risk goals get a deeper grill before activation.
- Every setup interview ends with a human-approved contract summary before `goal_set` is called.
- The assistant conducts the setup interview through normal chat, guided by an extension nudge rather than a modal or wizard.
- Only after the setup interview is sufficiently resolved should Pi activate autonomous execution through `goal_set`.
- `goal_set` persists one rich objective string, not separate contract fields; the objective string contains outcome, completion criteria, decision policy, and ask-before boundaries.
- `goal_complete` is the only agent tool that can mark a goal done; pause, resume, and cancel remain human command authority.
- Breaking changes are acceptable before wider installation; migrate to the new tool and command grammar without legacy aliases.
- The setup nudge must be tuned through empirical prompt testing with five example goals across five different problem levels before implementation is considered ready.
- Empirical tuning found the ambiguous UI/UX case needed clearer contract-part coverage; the nudge now requires a checklist of unresolved contract parts when asking one focused first question.
- **Blocked** is not **Paused**; **Paused** is user intent, **Blocked** is runtime safety.
- Pending user input is **Waiting on user**, not **Blocked**; `BLOCKED!` is reserved for no-work, ask-before, or budget boundaries.

## Example dialogue

> **Dev:** "Should the goal UI show token usage first?"
> **Domain expert:** "No — first tell me whether Pi is still working autonomously. Budget and objective are secondary."

## Flagged ambiguities

- "UI status" previously mixed objective, budget, and autonomy. Resolved: **Autonomy Signal** is the primary UI concept.
