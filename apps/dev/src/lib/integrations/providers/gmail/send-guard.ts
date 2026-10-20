import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Who an agent may email without a person approving first.
 *
 * An agent with write access to Gmail sends on its own, except to someone a person
 * has marked off limits. The marks are the CRM fields a workspace already keeps on its
 * contacts and companies, so there is no second list to maintain. A blocked send is not
 * a dead end: the agent shows the email on an approval card, a person approves it having
 * seen the real recipient, and the approved send goes through.
 *
 * The fields are read by name and a workspace that does not define them simply has no
 * marks, so nothing is blocked there. That is on purpose: refusing every send in a
 * workspace with no CRM would make the tool useless, and a mark that was never set
 * cannot be honoured.
 */
export interface BlockedRecipient {
	address: string
	/** Plain words for the agent and the person: why this address needs approval. */
	reason: string
}

const isTrue = (v: unknown) => v === true || v === 'true'

/** Contact field values that mean "do not contact on your own". */
const PROTECTED_LOSS_CATEGORIES = new Set(['personal_protected'])

export async function findBlockedRecipients(
	db: Database,
	workspaceId: string,
	addresses: string[],
): Promise<BlockedRecipient[]> {
	if (addresses.length === 0) return []
	const wanted = addresses.map((a) => a.toLowerCase())

	const contacts = await db
		.select({ id: objects.id, metadata: objects.metadata })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
				inArray(sql<string>`lower(${objects.metadata}->>'email')`, wanted),
			),
		)

	const blocked = new Map<string, string>()
	const needsCompanyCheck: Array<{ id: string; address: string }> = []

	for (const contact of contacts) {
		const meta = (contact.metadata ?? {}) as Record<string, unknown>
		const address = String(meta.email ?? '').toLowerCase()
		if (isTrue(meta.protected)) {
			blocked.set(address, 'is marked as protected')
		} else if (isTrue(meta.email_opt_out)) {
			blocked.set(address, 'has opted out of email')
		} else if (PROTECTED_LOSS_CATEGORIES.has(String(meta.loss_category ?? ''))) {
			blocked.set(address, 'is marked as a protected personal contact')
		} else {
			needsCompanyCheck.push({ id: contact.id, address })
		}
	}

	if (needsCompanyCheck.length > 0) {
		const companies = await db
			.select({
				contactId: relationships.sourceId,
				metadata: objects.metadata,
			})
			.from(relationships)
			.innerJoin(objects, eq(objects.id, relationships.targetId))
			.where(
				and(
					eq(relationships.type, 'works_at'),
					inArray(
						relationships.sourceId,
						needsCompanyCheck.map((c) => c.id),
					),
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'company'),
				),
			)
		const addressByContact = new Map(needsCompanyCheck.map((c) => [c.id, c.address]))
		for (const row of companies) {
			const meta = (row.metadata ?? {}) as Record<string, unknown>
			const address = addressByContact.get(row.contactId)
			if (address && isTrue(meta.protected)) {
				blocked.set(address, 'works at a company that is marked as protected')
			}
		}
	}

	return wanted.flatMap((address) => {
		const reason = blocked.get(address)
		return reason ? [{ address, reason }] : []
	})
}
