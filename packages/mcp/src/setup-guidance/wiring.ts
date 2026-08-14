/**
 * Bridge between the pure T1 check module and the MCP tool handlers.
 *
 * Two API surfaces:
 *   - **Sync helpers** (`readWorkspaceLlmReadiness`, `readStatusOrder`,
 *     `readConnectedProviders`, `composeLoopSteps`, `buildLoopSetupBlock`,
 *     `buildBetSetupBlock`) take pre-fetched data and return a `SetupBlock` —
 *     used by the read-side get handlers that already load the underlying rows.
 *   - **Async fetch-and-compose helpers** (`buildActorSetupBlockFromApi`,
 *     `buildBetSetupBlockFromApi`, `buildLoopSetupBlockFromApi`) do the
 *     fetching themselves and are used by mutation handlers where data isn't
 *     already in hand.
 *
 * `safeBuildSetupBlock` wraps any compute in a single `unknown` check on
 * failure so the primary tool response always ships.
 *
 * Extra API-call budget per mutation tool call:
 *   - actor (create/update):    1 (workspace)
 *   - bet   (create/update):    1 (workspace — reused for status order)
 *   - loop  (create/update):    ≤4 (workspace, integrations, triggers, actors)
 */

import { checkActor, checkBet, checkLoop } from './index'
import { toNextSteps } from './priority'
import { toProseBlock } from './prose'
import type {
	ActorInput,
	BetInput,
	LoopCheckContext,
	LoopInput,
	LoopStep,
	SetupCheck,
	WorkspaceLlmReadiness,
} from './types'

/** Shape of the block appended to every create/update/get tool response. */
export type SetupBlock = {
	checks: SetupCheck[]
	next_steps: SetupCheck[]
	prose: string
}

/**
 * Signature of the private `apiCall` in `server.ts` — passed in rather than
 * imported so this module has no dependency on the server's config shape.
 */
export type ApiCaller = (
	method: string,
	path: string,
	body?: unknown,
	options?: { workspaceId?: string; skipWorkspace?: boolean },
) => Promise<unknown>

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
 * to fetch context never fails the primary handler response.
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
 * shape of `claude_oauth` counts.
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
 * returns integration rows with a `provider` string field. Filters to active
 * integrations (or rows without a status field, which are treated as active).
 */
export function readConnectedProviders(rows: unknown): string[] {
	if (!Array.isArray(rows)) return []
	const providers = new Set<string>()
	for (const row of rows) {
		const r = row as { provider?: unknown; status?: unknown } | null
		if (!r) continue
		if (typeof r.status === 'string' && r.status !== 'active') continue
		if (typeof r.provider === 'string' && r.provider.length > 0) providers.add(r.provider)
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

/**
 * Merge multiple bet setup blocks (from a batched create/update) into one.
 * De-duplicates by (name + message) so a single workspace-level warn like
 * `agents_runnable` only appears once even across many nodes, while per-node
 * warns (`elevated_status` with different messages) all survive.
 */
export function mergeBetSetupBlocks(blocks: SetupBlock[]): SetupBlock {
	const seen = new Set<string>()
	const merged: SetupCheck[] = []
	for (const block of blocks) {
		for (const check of block.checks) {
			const key = `${check.name}:${check.message}`
			if (seen.has(key)) continue
			seen.add(key)
			merged.push(check)
		}
	}
	return buildBlock(merged)
}

// ─── Async fetch-and-compose helpers for mutation handlers ────────────────

type WorkspaceRow = {
	id: string
	settings?: Record<string, unknown> | null
}

async function loadWorkspace(
	apiCall: ApiCaller,
	workspaceId: string | undefined,
	defaultWorkspaceId: string | undefined,
): Promise<WorkspaceRow | null> {
	const workspaces = (await apiCall('GET', '/api/workspaces', undefined, {
		skipWorkspace: true,
	})) as WorkspaceRow[] | null
	if (!Array.isArray(workspaces) || workspaces.length === 0) return null
	const effective = workspaceId ?? defaultWorkspaceId
	if (effective) {
		const match = workspaces.find((w) => w.id === effective)
		if (match) return match
	}
	return workspaces[0] ?? null
}

/**
 * Async convenience: build the actor setup block by fetching workspace
 * settings, delegating to the pure check module. Load failure yields a single
 * `unknown` check via `safeBuildSetupBlock`.
 */
export async function buildActorSetupBlockFromApi(
	actor: ActorInput,
	apiCall: ApiCaller,
	options: { workspaceId?: string; defaultWorkspaceId?: string },
): Promise<SetupBlock> {
	return safeBuildSetupBlock('setup', async () => {
		const workspace = await loadWorkspace(
			apiCall,
			options.workspaceId,
			options.defaultWorkspaceId,
		)
		const readiness = readWorkspaceLlmReadiness(workspace?.settings ?? undefined)
		return buildBlock(checkActor(actor, { workspace: readiness }))
	})
}

/**
 * Async convenience: build the bet setup block by fetching workspace settings.
 * Callers that have already loaded the workspace row (e.g. `create_objects`'s
 * status-inference path) may pass it via `options.workspace` to skip the fetch.
 */
export async function buildBetSetupBlockFromApi(
	bet: BetInput,
	apiCall: ApiCaller,
	options: {
		workspaceId?: string
		defaultWorkspaceId?: string
		workspace?: WorkspaceRow | null
	},
): Promise<SetupBlock> {
	return safeBuildSetupBlock('setup', async () => {
		const workspace =
			options.workspace !== undefined
				? options.workspace
				: await loadWorkspace(apiCall, options.workspaceId, options.defaultWorkspaceId)
		const readiness = readWorkspaceLlmReadiness(workspace?.settings ?? undefined)
		const statusOrder = readStatusOrder(workspace?.settings ?? undefined, bet.type)
		return buildBetSetupBlock(bet, readiness, statusOrder)
	})
}

/**
 * Async convenience: build the loop setup block by fetching workspace
 * settings, connected integrations, and step trigger/agent rows in parallel.
 * `triggerIds` should be the union of the loop's pre-existing trigger ids and
 * any inline steps just created — both must already exist in the DB.
 */
export async function buildLoopSetupBlockFromApi(
	loop: LoopInput,
	apiCall: ApiCaller,
	options: {
		workspaceId?: string
		defaultWorkspaceId?: string
		triggerIds: string[]
		memberCount: number
	},
): Promise<SetupBlock> {
	return safeBuildSetupBlock('setup', async () => {
		const [workspace, integrationsRows, triggerRows] = await Promise.all([
			loadWorkspace(apiCall, options.workspaceId, options.defaultWorkspaceId).catch(() => null),
			apiCall('GET', '/api/integrations', undefined, { workspaceId: options.workspaceId }).catch(
				() => [] as unknown,
			),
			options.triggerIds.length > 0
				? apiCall('GET', '/api/triggers', undefined, { workspaceId: options.workspaceId }).catch(
						() => [] as unknown,
					)
				: Promise.resolve([] as unknown),
		])
		const matchedTriggers = Array.isArray(triggerRows)
			? (triggerRows as Array<Record<string, unknown>>).filter((t) =>
					options.triggerIds.includes(t.id as string),
				)
			: []
		const agentIds = Array.from(
			new Set(
				matchedTriggers
					.map((t) => t.targetActorId)
					.filter((v): v is string => typeof v === 'string'),
			),
		)
		const actorRows =
			agentIds.length > 0
				? await apiCall(
						'GET',
						`/api/actors?ids=${agentIds.map(encodeURIComponent).join(',')}`,
						undefined,
						{ workspaceId: options.workspaceId },
					).catch(() => [] as unknown)
				: []
		const steps = composeLoopSteps(options.triggerIds, matchedTriggers, actorRows)
		return buildLoopSetupBlock(loop, {
			workspace: readWorkspaceLlmReadiness(workspace?.settings ?? undefined),
			connectedProviders: readConnectedProviders(integrationsRows),
			steps,
			memberCount: options.memberCount,
		})
	})
}
