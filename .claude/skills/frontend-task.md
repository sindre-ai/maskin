---
name: frontend-task
description: Orchestrates the frontend agent team to plan, review, implement, and review frontend changes
user_invocable: true
---

# Frontend Task Orchestration

You are orchestrating a frontend task using a team of specialized agents. Follow this workflow exactly.

## Workflow

### 1. Assess the Task

Read the user's request and classify it:
- **Trivial**: typo fix, single-line change, obvious one-file fix → skip to Phase 2
- **Non-trivial**: new feature, multi-file change, UI addition, behavior change → start at Phase 1

### 2. Create the Team

Create a team with these three agents (defined in `.claude/agents/`):
- `frontend-planner` — explores codebase and creates implementation plan
- `frontend-reviewer` — reviews plans and implementations for quality
- `frontend-implementer` — writes the code following approved plans

### 3. Phase 1: Plan + Review (skip for trivial tasks)

Create these tasks:

**Task A**: "Plan: {description of the frontend task}"
- Assign to: `frontend-planner`
- The planner will explore existing components, hooks, and patterns, then produce a structured plan

**Task B**: "Review the plan" (depends on Task A)
- Assign to: `frontend-reviewer`
- The reviewer checks the plan for component reuse, placement consistency, and rule compliance
- If the reviewer sends feedback, the planner addresses it and the reviewer re-checks
- **Max 2 feedback rounds** — after that, the reviewer approves with notes and we proceed

### 4. Phase 2: Implement + Review

**Task C**: "Implement the approved plan" (depends on Task B, or no dependency for trivial tasks)
- Assign to: `frontend-implementer`
- The implementer follows the approved plan exactly, then runs lint + type-check

**Task D**: "Review the implementation" (depends on Task C)
- Assign to: `frontend-reviewer`
- The reviewer checks the code against the rules and the approved plan
- If the reviewer sends feedback, the implementer fixes and the reviewer re-checks
- **Max 2 feedback rounds** — after that, the reviewer approves with notes

### 5. Finalize

When all tasks are complete:
1. Run `pnpm lint` and `pnpm type-check` as a final safety net
2. Summarize what was done for the user
3. List any "approved with notes" items that should be addressed later

## Important Notes

- The agents communicate directly with each other for feedback loops — you don't need to relay messages
- Each agent reads `.claude/rules/frontend.md` and `apps/web/CLAUDE.md` at startup
- The reviewer is the quality gate — nothing ships without reviewer approval
- If the task involves adding a new shadcn/ui component, use: `cd apps/web && npx shadcn@latest add <component> --yes`
- For tasks that touch both frontend and backend, only handle the frontend portion here
