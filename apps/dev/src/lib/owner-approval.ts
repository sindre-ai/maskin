import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { ownerApprovals } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'

/**
 * The owner approval record: the one place every "the owner approved this" is written and read.
 * Later steps (filing hand-off, VAT) read it with findOwnerApprovals and must not keep a table of
 * their own. kind says what was approved, subject which one, figuresHash the sha256 of the figures
 * the owner saw, so a reader can check they still match.
 */
export type OwnerApproval = typeof ownerApprovals.$inferSelect

/** The first kind: the owner's final approval of a period's books in Dinero. */
export const OWNER_APPROVAL_DINERO_BOOKS = 'dinero_books'

/** sha256 of a value's canonical JSON (object keys sorted), so equal figures give equal hashes. */
export function hashFigures(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
	}
	return JSON.stringify(value ?? null)
}

export async function recordOwnerApproval(
	db: Database,
	p: {
		workspaceId: string
		kind: string
		subject: string
		figuresHash: string
		approvedBy: string
		expiresAt?: Date | null
	},
): Promise<OwnerApproval> {
	const [row] = await db
		.insert(ownerApprovals)
		.values({
			workspaceId: p.workspaceId,
			kind: p.kind,
			subject: p.subject,
			figuresHash: p.figuresHash,
			approvedBy: p.approvedBy,
			expiresAt: p.expiresAt ?? null,
		})
		.returning()
	if (!row) throw new Error('Could not write the owner approval')
	return row
}

/** The approvals of one kind in a workspace, newest first. Expired ones are left out. */
export async function findOwnerApprovals(
	db: Database,
	workspaceId: string,
	kind: string,
	now = new Date(),
): Promise<OwnerApproval[]> {
	const rows = await db
		.select()
		.from(ownerApprovals)
		.where(and(eq(ownerApprovals.workspaceId, workspaceId), eq(ownerApprovals.kind, kind)))
		.orderBy(desc(ownerApprovals.approvedAt))
	return rows.filter((r) => !r.expiresAt || r.expiresAt > now)
}
