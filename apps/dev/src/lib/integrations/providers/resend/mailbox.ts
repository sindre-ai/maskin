import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { and, eq, ne, sql } from 'drizzle-orm'

/**
 * The address an agent sends email from. It lives in `actors.metadata.mailbox` and nowhere
 * the agent can reach: the actor update route accepts `mailbox` only from a human workspace
 * admin. The `email` column is no use for this, because any workspace member may change it.
 *
 * The sender of a Resend email is always read from here, never from the call, so an agent
 * cannot send as someone else. No mailbox, no send.
 */

// One plain address: no display name, quotes, spaces, angle brackets or control characters.
const MAILBOX_RE =
	/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/** The normalised address, or null when the input is not one plain email address. */
export function normalizeMailbox(input: string): string | null {
	const address = input.trim().toLowerCase()
	return address.length <= 254 && MAILBOX_RE.test(address) ? address : null
}

/** The mailbox recorded for an agent, or null when none is (or the stored value is not valid). */
export async function readAgentMailbox(db: Database, actorId: string): Promise<string | null> {
	const [row] = await db
		.select({ mailbox: sql<string | null>`${actors.metadata}->>'mailbox'`, type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (!row || row.type !== 'agent' || !row.mailbox) return null
	return normalizeMailbox(row.mailbox)
}

/** Another actor that already holds this address, so two agents can never share a sender. */
export async function mailboxTakenBy(
	db: Database,
	address: string,
	exceptActorId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(
			and(sql`lower(${actors.metadata}->>'mailbox') = ${address}`, ne(actors.id, exceptActorId)),
		)
		.limit(1)
	return row?.id ?? null
}
