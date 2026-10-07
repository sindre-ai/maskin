/**
 * Sender-to-contact resolution for Unipile message.new deliveries.
 *
 * Contacts store only `linkedin_url`, and the webhook payload carries the
 * sender's provider id, so the match is: payload public identifier (if the
 * payload carries one), otherwise one getProfile call on cache miss, then
 * EXACT slug equality against the contact's `/in/` segment.
 *
 * Runs inline on the webhook hot path, so every network step is single-attempt
 * (no callLinkedInWithRetry), capped at LOOKUP_TIMEOUT_MS and capped at
 * MAX_CONCURRENT_LOOKUPS across the process. A lookup failure never throws:
 * it resolves to `unresolved` and the delivery still answers 200.
 *
 * Nothing here returns or logs a name, public identifier or message text.
 */

import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, or, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import { classifyLinkedInResponse } from './errors'
import type { IntegrationRow } from './event-map'
import { slugFromLinkedinUrl } from './linkedin-slug'
import { buildLinkedInClientForWebhook } from './webhook'

/** A hot-path lookup must finish well inside the 4 second work budget. */
export const LOOKUP_TIMEOUT_MS = 2500
export const MAX_CONCURRENT_LOOKUPS = 5
export const CHAT_CONTACT_TTL_MS = 60 * 60 * 1000
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5000

export interface ResolvedContact {
	id: string
	status: string
	driverId: string | null
}

export type SenderResolution =
	| { kind: 'known'; contact: ResolvedContact; publicIdentifier: string | null; ambiguous: boolean }
	| { kind: 'cold' }
	| { kind: 'unresolved'; reason: string }

// ── In-process caches ──────────────────────────────────────────────────────

class TtlCache<V> {
	private readonly entries = new Map<string, { value: V; expiresAt: number }>()

	constructor(private readonly ttlMs: number) {}

	get(key: string): V | undefined {
		const hit = this.entries.get(key)
		if (!hit) return undefined
		if (hit.expiresAt <= Date.now()) {
			this.entries.delete(key)
			return undefined
		}
		return hit.value
	}

	set(key: string, value: V): void {
		if (this.entries.size >= MAX_CACHE_ENTRIES) {
			const now = Date.now()
			for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k)
			// Still full: drop the oldest insertion.
			if (this.entries.size >= MAX_CACHE_ENTRIES) {
				const oldest = this.entries.keys().next().value
				if (oldest !== undefined) this.entries.delete(oldest)
			}
		}
		this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
	}

	delete(key: string): void {
		this.entries.delete(key)
	}

	clear(): void {
		this.entries.clear()
	}
}

/** integration id + chat id -> contact id. */
const chatContactCache = new TtlCache<string>(CHAT_CONTACT_TTL_MS)
/** sender provider id -> public identifier. */
const profileCache = new TtlCache<string>(PROFILE_TTL_MS)

export function __resetSenderCachesForTests(): void {
	chatContactCache.clear()
	profileCache.clear()
	active = 0
	waiters.length = 0
}

// ── Concurrency cap with a deadline ────────────────────────────────────────

class LookupTimeoutError extends Error {
	constructor() {
		super('sender lookup timed out')
		this.name = 'LookupTimeoutError'
	}
}

interface Waiter {
	grant: () => void
	cancelled: boolean
}

let active = 0
const waiters: Waiter[] = []

function release(): void {
	while (waiters.length > 0) {
		const next = waiters.shift()
		if (next && !next.cancelled) {
			// Hand the slot straight over; `active` stays the same.
			next.grant()
			return
		}
	}
	active = Math.max(0, active - 1)
}

/**
 * Run `fn` holding one of MAX_CONCURRENT_LOOKUPS slots. The deadline covers the
 * queue wait and the call together, and the slot is freed when the deadline
 * fires even if `fn` never settles, so a hung upstream cannot starve the pool.
 */
async function withLookupSlot<T>(fn: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new LookupTimeoutError()), LOOKUP_TIMEOUT_MS)
	})
	const waiter: Waiter = { grant: () => {}, cancelled: false }
	let granted = false
	let settled = false
	const acquired = new Promise<void>((resolve) => {
		waiter.grant = resolve
		if (active < MAX_CONCURRENT_LOOKUPS) {
			active++
			resolve()
		} else {
			waiters.push(waiter)
		}
	}).then(() => {
		granted = true
		// The deadline fired while the slot was being handed over: give it back.
		if (settled) release()
	})
	try {
		await Promise.race([acquired, deadline])
		return await Promise.race([fn(), deadline])
	} finally {
		if (timer) clearTimeout(timer)
		settled = true
		if (granted) release()
		else waiter.cancelled = true
	}
}

// ── Public identifier ──────────────────────────────────────────────────────

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The sender's public identifier when the payload itself carries one. */
function readPayloadPublicIdentifier(message: Record<string, unknown>): string | null {
	const sender = isRecord(message.sender) ? message.sender : null
	return str(message.sender_public_identifier) ?? (sender ? str(sender.public_identifier) : null)
}

/** One getProfile call, single attempt. Null on any failure. */
async function lookupPublicIdentifier(
	integration: IntegrationRow,
	accountId: string,
	senderId: string,
): Promise<{ publicIdentifier: string } | { failure: string }> {
	try {
		return await withLookupSlot(async () => {
			const client = buildLinkedInClientForWebhook((input, init) =>
				fetch(input, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }),
			)
			const result = await client.getProfile({ account_id: accountId, identifier: senderId })
			const code = classifyLinkedInResponse(result.status, result.body)
			if (code !== null) return { failure: code }
			const publicIdentifier = isRecord(result.body) ? str(result.body.public_identifier) : null
			return publicIdentifier ? { publicIdentifier } : { failure: 'no_public_identifier' }
		})
	} catch (err) {
		const failure =
			err instanceof LookupTimeoutError
				? 'timeout'
				: err instanceof Error && err.name === 'TimeoutError'
					? 'timeout'
					: 'lookup_error'
		logger.warn('linkedin-unipile webhook: sender lookup failed', {
			integration_id: integration.id,
			failure,
			error: err instanceof Error ? err.message : String(err),
		})
		return { failure }
	}
}

// ── Contact match ──────────────────────────────────────────────────────────

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Contacts in the workspace whose linkedin_url carries exactly this slug. SQL
 * only narrows (substring, coarse); equality on the segment is decided in code
 * with the shared slug helper, so "martin" never matches "martin-emil-...".
 */
async function findContactsBySlug(
	db: Database,
	workspaceId: string,
	publicIdentifier: string,
): Promise<Array<ResolvedContact & { url: string | null }>> {
	const slug = slugFromLinkedinUrl(`/in/${encodeURIComponent(publicIdentifier)}`)
	if (!slug) return []
	const url = sql<string | null>`${objects.metadata}->>'linkedin_url'`
	// A stored url may hold the slug percent-encoded or decoded.
	const patterns = [
		...new Set([slug, encodeURIComponent(slug).toLowerCase()].map((s) => `%/in/${escapeLike(s)}%`)),
	]
	const rows = await db
		.select({ id: objects.id, status: objects.status, driver: objects.driver, url })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
				or(...patterns.map((p) => sql`lower(${url}) like ${p}`)),
			),
		)
		.orderBy(objects.createdAt, objects.id)
	return rows
		.filter((row) => slugFromLinkedinUrl(row.url) === slug)
		.map((row) => ({ id: row.id, status: row.status, driverId: row.driver, url: row.url }))
}

async function findContactById(
	db: Database,
	workspaceId: string,
	contactId: string,
): Promise<ResolvedContact | null> {
	const [row] = await db
		.select({ id: objects.id, status: objects.status, driver: objects.driver })
		.from(objects)
		.where(
			and(
				eq(objects.id, contactId),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
			),
		)
		.limit(1)
	return row ? { id: row.id, status: row.status, driverId: row.driver } : null
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function resolveSender(input: {
	db: Database
	integration: IntegrationRow
	message: Record<string, unknown>
	chatId: string | null
	senderId: string | null
	accountId: string | null
}): Promise<SenderResolution> {
	const { db, integration, message, chatId, senderId, accountId } = input
	const chatKey = chatId ? `${integration.id}:${chatId}` : null

	// A chat we already matched skips every lookup below. Status and driver are
	// read fresh by id; a contact that no longer exists drops the cache entry.
	if (chatKey) {
		const cachedId = chatContactCache.get(chatKey)
		if (cachedId) {
			const contact = await findContactById(db, integration.workspaceId, cachedId)
			if (contact) {
				return { kind: 'known', contact, publicIdentifier: null, ambiguous: false }
			}
			chatContactCache.delete(chatKey)
		}
	}

	let publicIdentifier = readPayloadPublicIdentifier(message)
	if (!publicIdentifier && senderId) {
		publicIdentifier = profileCache.get(senderId) ?? null
		if (!publicIdentifier) {
			if (!accountId) return { kind: 'unresolved', reason: 'no_account_id' }
			const looked = await lookupPublicIdentifier(integration, accountId, senderId)
			if ('failure' in looked) return { kind: 'unresolved', reason: looked.failure }
			publicIdentifier = looked.publicIdentifier
			profileCache.set(senderId, publicIdentifier)
		}
	}
	if (!publicIdentifier || !slugFromLinkedinUrl(`/in/${encodeURIComponent(publicIdentifier)}`)) {
		return { kind: 'unresolved', reason: 'no_public_identifier' }
	}

	const matches = await findContactsBySlug(db, integration.workspaceId, publicIdentifier)
	if (matches.length === 0) return { kind: 'cold' }

	const ownerId = integration.actorId ?? integration.createdBy
	const ambiguous = matches.length > 1
	const chosen = (ambiguous ? matches.find((m) => m.driverId === ownerId) : null) ?? matches[0]
	if (!chosen) return { kind: 'cold' }
	if (ambiguous) {
		logger.warn('linkedin-unipile webhook: several contacts match one sender', {
			integration_id: integration.id,
			contact_ids: matches.map((m) => m.id),
			chosen_contact_id: chosen.id,
		})
	}
	if (chatKey) chatContactCache.set(chatKey, chosen.id)
	return {
		kind: 'known',
		contact: { id: chosen.id, status: chosen.status, driverId: chosen.driverId },
		publicIdentifier,
		ambiguous,
	}
}
