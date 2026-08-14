/**
 * Bridge between the pure T1 check module and the MCP tool handlers. Fetches
 * the context each check-set needs (workspace LLM readiness, connected
 * providers, loop steps) and returns a `{ checks, next_steps, prose }` block
 * the handlers can attach directly to their response.
 *
 * Every helper here degrades gracefully — a fetch failure produces an
 * `unknown` check rather than throwing, so the primary tool response always
 * ships.
 */

import { checkBet, checkLoop } from './index'
import { toNextSteps } from './priority'
import { toProseBlock } from './prose'
import type {
	BetInput,
	LoopCheckContext,
	LoopInput,
	LoopStep,
	SetupCheck,
	WorkspaceLlmReadiness,
} from './types'

export type SetupBlock = {
	checks: SetupCheck[]
	next_steps: SetupCheck[]
	prose: string
}

function buildBlock(checks: SetupCheck[]): SetupBlock {
	const next_steps = toNextSteps(checks)
	return {
		checks,
		next_steps,
		prose: toProseBlock(next_steps),
	}
}

/**
 * Wrap a full setup-block computation in a single `unknown` check so a failure
 * to fetch context never fails the primary handler response. Used at the
 * outermost seam of both `get_loop include:['setup']` and
 * `get_objects include:['setup']`.
 */
export async function safeBuildSetupBlock(
	name: string,
	build: () => Promise<SetupBlock>,
): Promise<SetupBlock> {
	try {
		return await build()
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const checks: SetupCheck[] = [
			{
				name,
				status: 'unknown',
				message: `Could not compute setup block: ${message}`,
			},
		]
		return { checks, next_steps: [], prose: '' }
	}
}

/**
 * Read workspace LLM readiness from the settings object returned by
 * `GET /api/workspaces`. Any non-empty provider value in `llm_keys` or any
 * shape of `claude_oauth` counts — this mirrors the acceptance criteria from
 * the parent bet.
 */
export function readWorkspaceLlmReadiness(
	settings: Record<string, unknown> | null | undefined,
): WorkspaceLlmReadiness {
	const s = settings ?? {}
	const llmKeys = (s.llm_keys ?? {}) as Record<string, unknown>
	const hasLlmKey = Object.values(llmKeys).some((v) => typeof v === 'string' && v.trim().length > 0)
	const claudeOAuth = s.claude_oauth
	const hasClaudeOAuth =
		claudeOAuth != null && (typeof claudeOAuth !== 'object' || Object.keys(claudeOAuth).length > 0)
	return { hasLlmKey, hasClaudeOAuth }
}

/**
 * Extract the ordered status list for a given object type from workspace
 * `settings.statuses`. Returns `[]` when the type has no configured order.
 */
export function readStatusOrder(
	settings: Record<string, unknown> | null | undefined,
	type: string,
): string[] {
	const s = settings ?? {}
	const statuses = (s.statuses ?? {}) as Record<string, unknown>
	const order = statuses[type]
	return Array.isArray(order) ? (order as string[]) : []
}

/**
 * Extract the flat provider names from `GET /api/integrations`. The endpoint
 * returns integration rows with a `provider` string field.
 */
export function readConnectedProviders(rows: unknown): string[] {
	if (!Array.isArray(rows)) return []
	const providers = new Set<string>()
	for (const row of rows) {
		const provider = (row as { provider?: unknown } | null)?.provider
		if (typeof provider === 'string' && provider.length > 0) providers.add(provider)
	}
	return Array.from(providers)
}

/**
 * Compose loop steps from the loop's `triggerIds`, the full set of workspace
 * triggers (batched), and the actor rows for each trigger's target agent.
 * Preserves the loop's declared trigger order.
 */
export function composeLoopSteps(
	triggerIds: string[],
	triggerRows: unknown,
	actorRows: unknown,
): LoopStep[] {
	const triggersById = new Map<string, Record<string, unknown>>()
	if (Array.isArray(triggerRows)) {
		for (const row of triggerRows) {
			const id = (row as { id?: unknown } | null)?.id
			if (typeof id === 'string') triggersById.set(id, row as Record<string, unknown>)
		}
	}
	const actorsById = new Map<string, Record<string, unknown>>()
	if (Array.isArray(actorRows)) {
		for (const row of actorRows) {
			const id = (row as { id?: unknown } | null)?.id
			if (typeof id === 'string') actorsById.set(id, row as Record<string, unknown>)
		}
	}
	return triggerIds.map((triggerId) => {
		const trigger = triggersById.get(triggerId)
		const targetActorId =
			typeof trigger?.targetActorId === 'string' ? (trigger.targetActorId as string) : null
		const actor = targetActorId ? actorsById.get(targetActorId) : undefined
		const agent = actor
			? {
					id: actor.id as string,
					name: (actor.name as string | undefined) ?? null,
					systemPrompt: (actor.systemPrompt as string | undefined) ?? null,
				}
			: null
		return {
			triggerId,
			triggerName: (trigger?.name as string | undefined) ?? null,
			triggerActionPrompt: (trigger?.actionPrompt as string | undefined) ?? null,
			triggerConfig: trigger?.config,
			agent,
		}
	})
}

/** Build the setup block for a loop given the assembled context. */
export function buildLoopSetupBlock(loop: LoopInput, ctx: LoopCheckContext): SetupBlock {
	return buildBlock(checkLoop(loop, ctx))
}

/** Build the setup block for a bet-shaped object given its status order. */
export function buildBetSetupBlock(
	bet: BetInput,
	workspace: WorkspaceLlmReadiness,
	statusOrder: string[],
): SetupBlock {
	return buildBlock(checkBet(bet, { workspace, statusOrder }))
}
