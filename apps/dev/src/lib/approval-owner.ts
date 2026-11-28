import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Who may approve a post for an account. A workspace records it in settings.approval_owners as
 * { account: [person actor ids] }; a post names its account in metadata.account. Names compare
 * in lower case with dash and underscore as the same. A workspace with no map approves as it
 * always did. With a map, a post (it has an account key, or it is a LinkedIn post) is approved
 * only by a person listed for its account. An empty account, or one the map does not list, is
 * refused, because nobody is recorded as owning it. Anything that is not a post is left alone.
 */

export const normalizeAccount = (account: string): string =>
	account.trim().toLowerCase().replace(/-/g, '_')

export type ApprovalOwnerCheck = { ok: true } | { ok: false; message: string }

/** Read defensively: a malformed settings blob must never block an approval it does not govern. */
function readOwnerMap(settings: unknown): Map<string, string[]> | null {
	const raw = (settings as { approval_owners?: unknown } | null)?.approval_owners
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const map = new Map<string, string[]>()
	for (const [account, ids] of Object.entries(raw)) {
		if (!Array.isArray(ids)) continue
		map.set(
			normalizeAccount(account),
			ids.filter((id): id is string => typeof id === 'string'),
		)
	}
	return map.size > 0 ? map : null
}

export async function checkApprovalOwner(
	db: Database,
	params: { workspaceId: string; actorId: string; metadata: unknown },
): Promise<ApprovalOwnerCheck> {
	const metadata = params.metadata as Record<string, unknown> | null
	if (!metadata || typeof metadata !== 'object') return { ok: true }
	// A post for an account: it names one, or it is a LinkedIn post, which always has one to name.
	const isPost =
		'account' in metadata ||
		metadata.kind === 'linkedin_post' ||
		metadata.content_type === 'linkedin_post'
	if (!isPost) return { ok: true }

	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, params.workspaceId))
		.limit(1)
	const owners = readOwnerMap(row?.settings)
	if (!owners) return { ok: true }

	const account = typeof metadata.account === 'string' ? metadata.account : ''
	if (!account.trim()) {
		return {
			ok: false,
			message:
				'This post names no account, so nobody is recorded as its owner. Set the account first.',
		}
	}
	const allowed = owners.get(normalizeAccount(account))
	if (!allowed) {
		return {
			ok: false,
			message: `Nobody is recorded as the owner of the account "${account}", so it cannot be approved yet.`,
		}
	}
	if (!allowed.includes(params.actorId)) {
		return {
			ok: false,
			message: `Only the owner of the account "${account}" can approve this post. You are not recorded as an owner of it.`,
		}
	}
	return { ok: true }
}
