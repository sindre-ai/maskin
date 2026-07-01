import { logger } from '../../../logger'
import type { NormalizedEvent, WebhookFanOutContext } from '../../types'

// GitHub commit SHAs are 40-char hex today (SHA-1). Accepting 40–64 chars keeps
// us forward-compatible with SHA-256 without opening the door to arbitrary
// strings landing in downstream metadata.
const SHA_RE = /^[a-f0-9]{40,64}$/i

/**
 * Pre-handler for the shared webhook route. Runs after signature verification
 * and JSON parsing but before normalization. For `deployment_status` payloads:
 *
 *   - Missing / malformed SHA → 400 (logged). GitHub always populates this;
 *     an absent value means the payload shape is wrong and the sender needs
 *     to see it.
 *   - `state` other than `success`, or `environment` other than `production`
 *     → 200 with `skipped: 'filtered'` (logged). We only care about
 *     production successes; every other combination is dropped without
 *     attribution or metadata writes.
 *
 * For every other GitHub event this pre-handler is a no-op (returns null) and
 * the shared route proceeds to normalization + fan-out as before.
 */
export const githubWebhookPreHandler = (
	payload: unknown,
	headers: Record<string, string>,
): { body: unknown; status?: number } | null => {
	if (headers['x-github-event'] !== 'deployment_status') return null

	const body = (payload ?? {}) as Record<string, unknown>
	const deployment = body.deployment as Record<string, unknown> | undefined
	const deploymentStatus = body.deployment_status as Record<string, unknown> | undefined
	const deliveryId = headers['x-github-delivery']

	const sha = deployment?.sha
	if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
		logger.warn('github deployment_status rejected: missing or invalid SHA', {
			deliveryId,
			shaType: typeof sha,
			shaSample: typeof sha === 'string' ? sha.slice(0, 12) : null,
		})
		return {
			status: 400,
			body: {
				error: {
					code: 'BAD_REQUEST',
					message: 'deployment_status payload has missing or invalid SHA',
				},
			},
		}
	}

	const state = deploymentStatus?.state
	const environment = deployment?.environment
	if (state !== 'success' || environment !== 'production') {
		logger.info('github deployment_status dropped: not a production success', {
			deliveryId,
			state,
			environment,
			sha,
		})
		return { status: 200, body: { ok: true, skipped: 'filtered' } }
	}

	return null
}

/** Read the per-delivery UUID from the `X-GitHub-Delivery` header. */
export const githubExtractDeliveryId = (
	_payload: unknown,
	headers: Record<string, string>,
): string | null => {
	const delivery = headers['x-github-delivery']
	return typeof delivery === 'string' && delivery.length > 0 ? delivery : null
}

/**
 * Result of a deployment-status attribution pass. Kept in this module so T3
 * can slot its Pass 1 / Pass 2 SHA matching into `attributeDeployment` without
 * touching the receiver plumbing.
 */
export interface DeploymentAttributionResult {
	matched: boolean
}

/**
 * T2 stub for deployment-status attribution. Always returns `{ matched: false }`
 * so the receiver takes the unattributed-log branch. T3 replaces this with the
 * two-pass SHA match + atomic `bet.metadata.deployed_at` / `awaiting_deploy`
 * write described in the architecture decision.
 *
 * `db`, `workspaceId`, and the normalized event are typed loosely to avoid
 * dragging @maskin/db into the provider module.
 */
export async function attributeDeployment(_args: {
	db: unknown
	workspaceId: string
	sha: string
	deployedAt: string
	installationId: string
}): Promise<DeploymentAttributionResult> {
	return { matched: false }
}

/**
 * Fan-out hook for GitHub webhooks. For `deployment_status`, runs attribution
 * and always returns `[]` — the deploy is not a downstream trigger source, so
 * no event row lands in `events`. When attribution finds no match (T2 stub or
 * a T3 miss), logs the unattributed delivery so the aging sweep (T4) can pick
 * it up later.
 *
 * For every other GitHub event, returns `[normalized]` so the shared route's
 * default single-event insert path is preserved.
 */
export async function githubWebhookFanOut(ctx: WebhookFanOutContext): Promise<NormalizedEvent[]> {
	if (ctx.normalized.entityType !== 'github.deployment_status') {
		return [ctx.normalized]
	}

	const data = ctx.normalized.data
	const sha = data.deployment_sha as string
	// Prefer the status timestamp (when GitHub marked the deploy successful).
	// updated_at is what state transitions write; created_at is a safe fallback
	// for older delivery shapes.
	const deployedAt =
		(data.deployment_status_updated_at as string | undefined) ??
		(data.deployment_status_created_at as string | undefined) ??
		new Date().toISOString()

	const result = await attributeDeployment({
		db: ctx.db,
		workspaceId: ctx.workspaceId,
		sha,
		deployedAt,
		installationId: ctx.normalized.installationId,
	})

	if (!result.matched) {
		logger.info('github deployment_status unattributed', {
			workspaceId: ctx.workspaceId,
			deliveryId: data.delivery_id ?? null,
			sha,
			deployedAt,
		})
	}

	return []
}
