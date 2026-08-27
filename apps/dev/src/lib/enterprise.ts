import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from './logger'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Actor IDs designated enterprise on every workspace they bill-own. Read from
 * MASKIN_ENTERPRISE_ACTOR_IDS (comma-separated UUIDs) rather than a code
 * constant, so the account IDs never appear in the diff/PR history. See
 * PR #970.
 */
export function parseEnterpriseActorIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const raw = env.MASKIN_ENTERPRISE_ACTOR_IDS
	if (!raw) return new Set()
	const ids = new Set<string>()
	for (const entry of raw.split(',')) {
		const id = entry.trim()
		if (!id) continue
		if (!UUID_SHAPE.test(id)) {
			logger.warn('MASKIN_ENTERPRISE_ACTOR_IDS rejected malformed entry', {
				entryLength: id.length,
			})
			continue
		}
		ids.add(id.toLowerCase())
	}
	return ids
}

/**
 * True when `actorId` is on the ops allowlist itself.
 *
 * This is the *ops-rights* predicate, deliberately distinct from
 * `isEnterprise()` below: it answers "may this actor grant enterprise to a
 * workspace", not "is this workspace enterprise". Only the env allowlist can
 * confer ops rights — `enterprise_granted` must never do so, or a workspace
 * that was granted enterprise could grant it onward, and the entitlement
 * becomes self-service. Keep these two apart.
 */
export function isEnterpriseActor(
	actorId: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!actorId) return false
	return parseEnterpriseActorIds(env).has(actorId.toLowerCase())
}

/**
 * A workspace's enterprise status: the ops-granted per-workspace flag, OR an
 * enterprise billing owner.
 *
 * This is the single predicate for everything enterprise confers:
 *
 *   - BYO-LLM credentials (Claude OAuth, custom endpoint, own API key)
 *   - exemption from the plan spend cap (`checkPlanCap`)
 *   - exemption from credit debiting (`debitCreditForSession`)
 *   - exemption from the seat cap and the ownership cap
 *   - the `enterprise` billing plan shown in the UI
 *
 * It replaces the former `byollmEntitled()` / `isEnterpriseWorkspace()` pair.
 * Those encoded BYO-LLM as a capability that could be granted *without*
 * enterprise status, so a `enterprise_granted` workspace brought its own LLM while
 * still being metered and credit-debited like a trial — two overlapping names
 * for one idea, and a standing invitation to check the wrong one. BYO-LLM is
 * now simply one of the things enterprise gets.
 *
 * Deliberately NOT derived from `billing.plan === 'enterprise'`: that plan is
 * the *result* of connecting a BYO credential (`billingAfterByoTransition`),
 * so keying the gate on it would be circular — and `customer.subscription.deleted`
 * writes that plan without checking entitlement, which would let any workspace
 * self-grant by canceling its subscription.
 */
export function isEnterprise(
	ws: { enterpriseGranted: boolean | null; billingOwnerId: string | null },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return ws.enterpriseGranted === true || isEnterpriseActor(ws.billingOwnerId, env)
}

/**
 * `isEnterprise()` for a caller that has a workspace id but not the row.
 *
 * Unlike the former env-only `isEnterpriseWorkspace()`, this cannot short-circuit on an
 * empty allowlist: `enterprise_granted` lives in the row, so the row must be
 * read to answer correctly. That costs one primary-key lookup on the
 * session-dispatch path. Callers that already hold the workspace row (e.g.
 * `session-manager`'s pre-flight) should call `isEnterprise()` directly rather
 * than paying for it twice.
 */
export async function isEnterpriseWorkspace(
	db: Pick<Database, 'select'>,
	workspaceId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	const [row] = await db
		.select({
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!row) return false
	return isEnterprise(row, env)
}
