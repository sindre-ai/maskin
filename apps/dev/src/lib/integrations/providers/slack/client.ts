import { logger } from '../../../logger'

const SLACK_API_BASE = 'https://slack.com/api'
const CACHE_TTL_MS = 5 * 60_000
const MAX_PAGES = 10
const PAGE_LIMIT = 200
const REQUEST_TIMEOUT_MS = 10_000

export type SlackConversationType = 'public_channel' | 'private_channel' | 'im' | 'mpim'

export interface SlackConversation {
	id: string
	name: string
	is_private: boolean
	is_im: boolean
	is_mpim: boolean
	is_channel: boolean
}

export interface SlackUser {
	id: string
	name: string
	real_name: string
	is_bot: boolean
}

interface CacheEntry<T> {
	value: T
	expiresAt: number
}

const conversationCache = new Map<string, CacheEntry<SlackConversation[]>>()
const userCache = new Map<string, CacheEntry<SlackUser[]>>()

function cacheKey(integrationId: string, suffix: string): string {
	return `${integrationId}:${suffix}`
}

function readCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
	const entry = map.get(key)
	if (!entry) return undefined
	if (entry.expiresAt < Date.now()) {
		map.delete(key)
		return undefined
	}
	return entry.value
}

function writeCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
	map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

interface SlackResponse {
	ok: boolean
	error?: string
	response_metadata?: { next_cursor?: string }
}

async function slackGet<T extends SlackResponse>(
	path: string,
	accessToken: string,
	params: Record<string, string>,
): Promise<T> {
	const search = new URLSearchParams(params).toString()
	let res: Response
	try {
		res = await fetch(`${SLACK_API_BASE}/${path}?${search}`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new Error(`Slack ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`)
		}
		throw err
	}
	const json = (await res.json()) as T
	if (!json.ok) {
		throw new Error(`Slack ${path} failed: ${json.error ?? 'unknown error'}`)
	}
	return json
}

/**
 * List Slack conversations the bot can see. Cursor-paginated; capped at MAX_PAGES * PAGE_LIMIT.
 * Cached per integration + types selection.
 */
export async function listSlackConversations(
	integrationId: string,
	accessToken: string,
	types: SlackConversationType[] = ['public_channel', 'private_channel', 'im', 'mpim'],
): Promise<SlackConversation[]> {
	const sortedTypes = [...types].sort()
	const key = cacheKey(integrationId, `conv:${sortedTypes.join(',')}`)
	const cached = readCache(conversationCache, key)
	if (cached) return cached

	const all: SlackConversation[] = []
	let cursor: string | undefined
	for (let i = 0; i < MAX_PAGES; i++) {
		const params: Record<string, string> = {
			limit: String(PAGE_LIMIT),
			types: sortedTypes.join(','),
			exclude_archived: 'true',
		}
		if (cursor) params.cursor = cursor

		const json = await slackGet<
			SlackResponse & {
				channels?: Array<Record<string, unknown>>
			}
		>('conversations.list', accessToken, params)

		for (const c of json.channels ?? []) {
			const id = c.id as string | undefined
			if (!id) continue
			all.push({
				id,
				name: (c.name as string | undefined) ?? '',
				is_private: Boolean(c.is_private),
				is_im: Boolean(c.is_im),
				is_mpim: Boolean(c.is_mpim),
				is_channel: Boolean(c.is_channel),
			})
		}

		cursor = json.response_metadata?.next_cursor
		if (!cursor) break
	}

	writeCache(conversationCache, key, all)
	return all
}

/**
 * List Slack users in the workspace. Cursor-paginated; capped at MAX_PAGES * PAGE_LIMIT.
 * Filters out deactivated users. Cached per integration.
 */
export async function listSlackUsers(
	integrationId: string,
	accessToken: string,
): Promise<SlackUser[]> {
	const key = cacheKey(integrationId, 'users')
	const cached = readCache(userCache, key)
	if (cached) return cached

	const all: SlackUser[] = []
	let cursor: string | undefined
	for (let i = 0; i < MAX_PAGES; i++) {
		const params: Record<string, string> = { limit: String(PAGE_LIMIT) }
		if (cursor) params.cursor = cursor

		const json = await slackGet<
			SlackResponse & {
				members?: Array<Record<string, unknown>>
			}
		>('users.list', accessToken, params)

		for (const m of json.members ?? []) {
			if (m.deleted) continue
			const id = m.id as string | undefined
			if (!id) continue
			const profile = m.profile as Record<string, unknown> | undefined
			all.push({
				id,
				name: (m.name as string | undefined) ?? '',
				real_name:
					(m.real_name as string | undefined) ?? (profile?.real_name as string | undefined) ?? '',
				is_bot: Boolean(m.is_bot),
			})
		}

		cursor = json.response_metadata?.next_cursor
		if (!cursor) break
	}

	writeCache(userCache, key, all)
	return all
}

/**
 * POST a body to a Slack web API method with the bot token. Slack returns a
 * JSON envelope `{ ok, error?, ... }` on every endpoint; throws when `ok` is
 * false so the caller can decide whether to swallow or surface the error.
 */
export async function slackPost<T extends SlackResponse>(
	path: string,
	accessToken: string,
	body: Record<string, unknown>,
): Promise<T> {
	let res: Response
	try {
		res = await fetch(`${SLACK_API_BASE}/${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new Error(`Slack ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`)
		}
		throw err
	}
	const json = (await res.json()) as T
	if (!json.ok) {
		throw new Error(`Slack ${path} failed: ${json.error ?? 'unknown error'}`)
	}
	return json
}

/**
 * Publish an App Home view for one user. Slack rate-limits this at tier 4
 * (~1/s/user); upstream callers should debounce.
 *
 * https://api.slack.com/methods/views.publish
 */
export async function slackViewsPublish(
	accessToken: string,
	args: { user_id: string; view: Record<string, unknown> },
): Promise<void> {
	await slackPost('views.publish', accessToken, args)
}

/**
 * Submit unfurls for links shared in a channel. Slack expects either
 * (channel, ts) OR (unfurl_id, source) to identify the message the unfurls
 * belong to; the newer webhook payload carries both, so callers should pass
 * whichever they have.
 *
 * https://api.slack.com/methods/chat.unfurl
 */
export async function slackChatUnfurl(
	accessToken: string,
	args: {
		channel?: string
		ts?: string
		unfurl_id?: string
		source?: string
		unfurls: Record<string, { blocks: Array<Record<string, unknown>> }>
	},
): Promise<void> {
	await slackPost('chat.unfurl', accessToken, args)
}

/** Reset caches (used in tests). */
export function _resetSlackCaches(): void {
	conversationCache.clear()
	userCache.clear()
	logger.debug('Slack lookup caches cleared')
}
