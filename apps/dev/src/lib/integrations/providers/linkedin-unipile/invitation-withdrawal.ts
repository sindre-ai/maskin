import type { Database } from '@maskin/db'
import { linkedinActions } from '@maskin/db/schema'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { CapSpec } from './caps'
import { type SentInvitation, type SentInvitationsPage, nextSentOffset } from './invitations'

/**
 * The rules and bookkeeping behind `withdraw_invitation`. Spec: bet aff468ba tech spec §2.2
 * (steps), §4 (cap), §5 (14-day floor). The Unipile calls and the order of the steps live in
 * operations.ts; this file holds what they lean on: the sent-list lookup with its 10 minute
 * cache, and the reads and writes on the permanent action log (`linkedin_actions`).
 *
 * Nothing here stores content. The log keeps opaque ids only: the invitation id (`ref_id`) and
 * the person's provider id (`target_provider_id`).
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** A sent invitation must be at least this many whole days old before it can be withdrawn. */
export const WITHDRAW_MIN_AGE_DAYS = 14

/** LinkedIn locks a new invite to the same person for up to this long after a withdrawal. */
export const REINVITE_LOCK_DAYS = 21

export const WITHDRAW_DAILY_CAP: CapSpec = {
	name: 'withdraw_invitation',
	limit: 30,
	tools: ['withdraw_invitation'],
}

/**
 * The log row that says "our list first showed this invitation id at created_at". It is only
 * written for invitations Unipile gave no send date for, and is the age source for those. It is
 * a bookkeeping row, not a tool call: kind `read`, outcome `ok`, one per (account, invitation id).
 */
export const FIRST_SEEN_TOOL = 'invitation_first_seen'

const SENT_LIST_PAGE_SIZE = 100
const SENT_LIST_CACHE_MS = 10 * 60 * 1000

export function addDays(from: Date, days: number): Date {
	return new Date(from.getTime() + days * DAY_MS)
}

// ── Sent-list lookup ────────────────────────────────────────────────────────

type SentListCache = {
	fetchedAt: number
	rows: Map<string, SentInvitation>
	/** Where the next page starts; null once the list has been read to its end. */
	nextOffset: number | null
}

export type SentListCaches = Map<string, SentListCache>

/** Per process; a miss only costs extra Unipile reads, so it needs no sharing between servers. */
const defaultCaches: SentListCaches = new Map()

/**
 * Finds one invitation id in the account's sent list, or null when the list does not hold it.
 *
 * The list is paged into a cache kept per account for 10 minutes. A lookup answers from the
 * cache, reads further pages only while the id has not been found, and so stops as soon as it is.
 * A cache past its 10 minutes starts over from the first page.
 */
export async function findSentInvitation(opts: {
	accountKey: string
	invitationId: string
	nowMs: number
	fetchPage: (offset: number, limit: number) => Promise<SentInvitationsPage>
	/** Called with every page read, e.g. to record first-seen times. */
	onPage?: (rows: SentInvitation[]) => Promise<void>
	caches?: SentListCaches
}): Promise<SentInvitation | null> {
	const caches = opts.caches ?? defaultCaches
	let entry = caches.get(opts.accountKey)
	if (!entry || opts.nowMs - entry.fetchedAt >= SENT_LIST_CACHE_MS) {
		entry = { fetchedAt: opts.nowMs, rows: new Map(), nextOffset: 0 }
		caches.set(opts.accountKey, entry)
	}
	for (;;) {
		const hit = entry.rows.get(opts.invitationId)
		if (hit) return hit
		if (entry.nextOffset === null) return null
		const offset = entry.nextOffset
		const page = await opts.fetchPage(offset, SENT_LIST_PAGE_SIZE)
		for (const row of page.invitations) entry.rows.set(row.invitation_id, row)
		entry.nextOffset = nextSentOffset(offset, SENT_LIST_PAGE_SIZE, page)
		await opts.onPage?.(page.invitations)
	}
}

/** Drops an invitation from the cache once it is gone from LinkedIn's list. */
export function forgetSentInvitation(
	accountKey: string,
	invitationId: string,
	caches: SentListCaches = defaultCaches,
): void {
	caches.get(accountKey)?.rows.delete(invitationId)
}

// ── Action log reads and writes ─────────────────────────────────────────────

/** The earlier successful withdrawal of this invitation id on this account, if any. */
export async function findPriorWithdrawal(
	db: Database,
	integrationId: string,
	invitationId: string,
): Promise<{ recipientProviderId: string | null; withdrawnAt: Date } | null> {
	const [row] = await db
		.select({ target: linkedinActions.targetProviderId, at: linkedinActions.createdAt })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, integrationId),
				eq(linkedinActions.tool, 'withdraw_invitation'),
				eq(linkedinActions.refId, invitationId),
				eq(linkedinActions.outcome, 'ok'),
			),
		)
		.limit(1)
	return row ? { recipientProviderId: row.target, withdrawnAt: row.at } : null
}

/**
 * When this account last withdrew an invitation to this person, if that was within the lock
 * window. One range read on (account, tool, time): at most 30 withdrawals a day over 21 days.
 */
export async function findRecentWithdrawalOfPerson(
	db: Database,
	integrationId: string,
	personProviderId: string,
	now: Date,
): Promise<Date | null> {
	const since = addDays(now, -REINVITE_LOCK_DAYS)
	const [row] = await db
		.select({ at: linkedinActions.createdAt })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, integrationId),
				eq(linkedinActions.tool, 'withdraw_invitation'),
				eq(linkedinActions.targetProviderId, personProviderId),
				eq(linkedinActions.outcome, 'ok'),
				gt(linkedinActions.createdAt, since),
			),
		)
		.orderBy(desc(linkedinActions.createdAt))
		.limit(1)
	return row?.at ?? null
}

export type LogScope = { workspaceId: string; actorId: string; integrationId: string }

/**
 * Notes the first time our list showed each of these invitations. Rows that already have a
 * first-seen row are left alone, so the time never moves. A failure is logged and swallowed:
 * the list read the agent asked for must not fail because the bookkeeping did.
 */
export async function recordFirstSeen(
	db: Database,
	scope: LogScope,
	rows: SentInvitation[],
): Promise<void> {
	if (rows.length === 0) return
	try {
		await db
			.insert(linkedinActions)
			.values(
				rows.map((row) => ({
					workspaceId: scope.workspaceId,
					integrationId: scope.integrationId,
					actorId: scope.actorId,
					tool: FIRST_SEEN_TOOL,
					kind: 'read',
					targetProviderId: row.recipient_provider_id,
					refId: row.invitation_id,
					outcome: 'ok',
				})),
			)
			.onConflictDoNothing()
	} catch (err) {
		logger.error('linkedin_actions first-seen insert failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** The time our list first showed this invitation id, or null when it never did. */
export async function findFirstSeen(
	db: Database,
	integrationId: string,
	invitationId: string,
): Promise<Date | null> {
	const [row] = await db
		.select({ at: linkedinActions.createdAt })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, integrationId),
				eq(linkedinActions.tool, FIRST_SEEN_TOOL),
				eq(linkedinActions.refId, invitationId),
				eq(linkedinActions.outcome, 'ok'),
			),
		)
		.orderBy(asc(linkedinActions.createdAt))
		.limit(1)
	return row?.at ?? null
}
