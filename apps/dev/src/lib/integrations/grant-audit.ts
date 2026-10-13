import type { Transaction } from '@maskin/db'
import type { CredentialAccessAction, CredentialTier } from '@maskin/db/schema'
import { insertCredentialAccessLog } from './credential-audit'
import { formatCredentialLogDetail } from './credential-log-detail'

// The grant code path's way onto the audit chain. Access-request code calls this and
// never the canonical detail writer directly. Every field is a uuid or a tier, taken
// from rows the server read, so request text (the reason, the session id) cannot be
// passed in even by mistake.

export type GrantAuditAction = Extract<
	CredentialAccessAction,
	'grant_requested' | 'grant_approved' | 'grant_denied' | 'grant_expired' | 'grant_revoked'
>

export interface GrantAuditRow {
	action: GrantAuditAction
	workspaceId: string
	integrationId: string
	/** Who did it: the requester for grant_requested, the approver for a decision. */
	actorId: string
	/** The credential's source column, as the read rows carry. */
	source: string
	/** Unique per event, so a retry cannot be mistaken for a second event. */
	requestId: string
	tier: CredentialTier
	approverActorId?: string | null
	grantId?: string | null
}

/** Appends one grant event to the chain, inside the transaction that makes it. */
export async function writeGrantAuditRow(tx: Transaction, row: GrantAuditRow): Promise<void> {
	await insertCredentialAccessLog(tx, {
		workspaceId: row.workspaceId,
		integrationId: row.integrationId,
		actorId: row.actorId,
		action: row.action,
		source: row.source,
		requestId: row.requestId,
		detail: formatCredentialLogDetail({
			approver: row.approverActorId ?? null,
			grant: row.grantId ?? null,
			tier: row.tier,
		}),
	})
}
