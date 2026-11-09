import type { Database, Transaction } from '@maskin/db'
import { events, notificationPreferences, workspaceMembers } from '@maskin/db/schema'
import { and, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'

// The summary email choice (notification_preferences.email_digest_enabled, migration 0138).
// null is "no choice yet"; a saved true/false always wins over any default.

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * True when the person did something real in the last 30 days: an event they authored in a
 * workspace they belong to. Two kinds of rows are not the person's own doing and do not count: the
 * bulk "integration created" rows (one run on 20 Oct wrote them for 44 human accounts) and the
 * "notification settings created" rows. Without those two exclusions the rule reaches about 52
 * people instead of 16.
 */
export async function hasRecentRealActivity(
	db: Database,
	actorId: string,
	now: Date = new Date(),
): Promise<boolean> {
	const since = new Date(now.getTime() - ACTIVE_WINDOW_MS)
	const [row] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.actorId, actorId),
				gt(events.createdAt, since),
				// Keeps the scan on the (workspace, created_at) index instead of the whole table.
				inArray(
					events.workspaceId,
					db
						.select({ id: workspaceMembers.workspaceId })
						.from(workspaceMembers)
						.where(eq(workspaceMembers.actorId, actorId)),
				),
				or(ne(events.entityType, 'integration'), ne(events.action, 'created')),
				or(ne(events.entityType, 'notification_preferences'), ne(events.action, 'created')),
			),
		)
		.limit(1)
	return !!row
}

/**
 * Whether the summary email is on for the person: the saved choice when there is one, otherwise
 * what the sending rule gives someone with no choice (on if recently active, else off).
 */
export async function resolveEmailDigestEnabled(
	db: Database,
	actorId: string,
	saved: boolean | null | undefined,
): Promise<boolean> {
	if (typeof saved === 'boolean') return saved
	return hasRecentRealActivity(db, actorId)
}

/**
 * Gives a new human account a saved settings row with email on. Runs in the sign-up transaction.
 * An existing row is left alone: a saved choice always wins.
 */
export async function createEmailOnPreferences(
	writer: Database | Transaction,
	actorId: string,
): Promise<void> {
	await writer
		.insert(notificationPreferences)
		.values({ actorId, emailDigestEnabled: true })
		.onConflictDoNothing({ target: notificationPreferences.actorId })
}

/** Turns email off, creating the settings row if there was none. Returns false when already off. */
export async function switchEmailOff(db: Database, actorId: string): Promise<boolean> {
	const now = new Date()
	const [before] = await db
		.select({ enabled: notificationPreferences.emailDigestEnabled })
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
		.limit(1)
	await db
		.insert(notificationPreferences)
		.values({ actorId, emailDigestEnabled: false, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: notificationPreferences.actorId,
			set: { emailDigestEnabled: false, updatedAt: now },
		})
	return before?.enabled !== false
}

/** Product event: only where the switch-off came from. No address, no text. */
export function trackEmailSwitchedOff(actorId: string, from: 'link' | 'settings'): void {
	void capturePosthogEvent('email_switched_off', actorId, { from })
}
