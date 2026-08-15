import type { Database } from '@maskin/db'
import {
	actors,
	integrations,
	objects,
	slackUserLinks,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { frontendBaseUrl } from '../../../file-urls'
import { logger } from '../../../logger'
import type { WorkspaceSettings } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import type { NormalizedEvent } from '../../types'
import { slackChatUnfurl } from './client'
import { buildObjectBlockId } from './interactive'
import { type SlackTier, refreshSlackTierIfStale } from './tier-cache'

/**
 * Cap on driver static_select options. Slack rejects `static_select` with
 * more than 100 options; workspaces beyond that would need external_select
 * (a T6 route change), which is out of scope for phase 1 dogfood.
 */
const MAX_DRIVER_OPTIONS = 100

/**
 * Cap on links per event. Slack batches `link_shared` deliveries for messages
 * that contain multiple URLs; anything beyond this is dropped to keep the
 * webhook well under Slack's 3s ack budget when we're doing per-link DB reads.
 */
const MAX_LINKS_PER_EVENT = 10

const FREE_TIER_EDIT_HINT = 'Inline edit needs Slack Pro.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ParsedObjectUrl {
	workspaceId: string
	objectId: string
}

/**
 * Recognize a maskin.io object URL like `${baseUrl}/{workspaceId}/objects/{objectId}`.
 * Returns null on anything else — a foreign host, a non-object route, or a
 * malformed UUID. Baseline: hostname must equal the frontend URL's hostname
 * so a phishing link on `maskin.io.example.com` never round-trips through the
 * unfurl pipeline and gets an authoritative-looking preview.
 */
export function parseMaskinObjectUrl(url: string, baseUrl: string): ParsedObjectUrl | null {
	let parsed: URL
	let base: URL
	try {
		parsed = new URL(url)
		base = new URL(baseUrl)
	} catch {
		return null
	}
	if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null
	const segments = parsed.pathname.split('/').filter(Boolean)
	if (segments.length < 3) return null
	const [workspaceId, kind, objectId] = segments
	if (!workspaceId || !objectId) return null
	if (kind !== 'objects') return null
	if (!UUID_RE.test(workspaceId) || !UUID_RE.test(objectId)) return null
	return { workspaceId, objectId }
}

interface ObjectRow {
	id: string
	workspaceId: string
	type: string
	title: string | null
	status: string
	driver: string | null
}

interface MemberOption {
	actorId: string
	name: string
}

interface BuildCompactUnfurlArgs {
	object: ObjectRow
	driverName: string | null
	statuses: string[]
	drivers: MemberOption[]
	tier: SlackTier
	baseUrl: string
}

/**
 * Escape strings we're about to drop into Slack mrkdwn link tags. Same
 * metacharacters as webhooks.ts — `|`, `<`, `>` are structural, everything
 * else renders literally.
 */
function escapeMrkdwnText(value: string): string {
	return value.replace(/[<|>]/g, (ch) => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&#124;'))
}

function objectUrl(baseUrl: string, workspaceId: string, objectId: string): string {
	return `${baseUrl}/${workspaceId}/objects/${objectId}`
}

/**
 * Build the three-line compact unfurl per the knowledge article rules.
 *
 *  - Line 1: Slack renders the app row (Maskin avatar + name) natively on
 *    every unfurl attachment; we don't emit a block for it.
 *  - Line 2: section with linkified title + overflow kebab accessory.
 *  - Line 3: actions block with the chip row.
 *
 * Pro/Business+ tier: status and driver chips are `static_select` accessories
 * so the pickers open in-place. The action block's `block_id` follows the
 * `obj:{workspaceId}:{objectId}` contract that T6's interactive route parses
 * server-side; the picker's `action_id` is either `status_select` or
 * `driver_select`, both of which T6 already accepts.
 *
 * Free tier: same visual layout, but the two editable chips become `↗`
 * deep-link buttons pointing back at the maskin.io object (`?edit=status` /
 * `?edit=driver` so the frontend can open the picker in-place), plus one
 * muted `context` block — "Inline edit needs Slack Pro." Never blocks.
 */
export function buildCompactUnfurl(args: BuildCompactUnfurlArgs): {
	blocks: Array<Record<string, unknown>>
} {
	const { object, driverName, statuses, drivers, tier, baseUrl } = args
	const url = objectUrl(baseUrl, object.workspaceId, object.id)
	const safeTitle = escapeMrkdwnText(object.title || '(untitled)')

	const overflow = {
		type: 'overflow',
		action_id: 'maskin_unfurl_overflow',
		options: [
			{
				text: { type: 'plain_text' as const, text: 'Subscribe', emoji: false },
				value: 'subscribe',
				url: `${url}?slack_action=subscribe`,
			},
			{
				text: { type: 'plain_text' as const, text: 'Copy link', emoji: false },
				value: 'copy',
				url,
			},
			{
				text: { type: 'plain_text' as const, text: 'Refresh', emoji: false },
				value: 'refresh',
				url: `${url}?slack_action=refresh`,
			},
		],
	}

	const titleSection = {
		type: 'section',
		text: { type: 'mrkdwn', text: `*<${url}|${safeTitle}>*` },
		accessory: overflow,
	}

	const typeChip = {
		type: 'button',
		text: { type: 'plain_text' as const, text: `● ${object.type}`, emoji: true },
		url,
		action_id: 'maskin_unfurl_type',
	}
	const commentChip = {
		type: 'button',
		text: { type: 'plain_text' as const, text: '💬 Comment', emoji: true },
		url: `${url}#comments`,
		action_id: 'maskin_unfurl_comment',
	}

	const chipRow: Array<Record<string, unknown>> = [typeChip]

	if (tier === 'free') {
		chipRow.push(
			{
				type: 'button',
				text: {
					type: 'plain_text' as const,
					text: `◐ ${object.status} ↗`,
					emoji: true,
				},
				url: `${url}?edit=status`,
				action_id: 'maskin_unfurl_status_link',
			},
			{
				type: 'button',
				text: {
					type: 'plain_text' as const,
					text: `👤 ${driverName ?? 'Unassigned'} ↗`,
					emoji: true,
				},
				url: `${url}?edit=driver`,
				action_id: 'maskin_unfurl_driver_link',
			},
		)
	} else {
		chipRow.push(
			buildStatusSelect(object.status, statuses),
			buildDriverSelect(object.driver, driverName, drivers),
		)
	}

	chipRow.push(commentChip)

	const actionsBlock = {
		type: 'actions',
		block_id: buildObjectBlockId(object.workspaceId, object.id),
		elements: chipRow,
	}

	const blocks: Array<Record<string, unknown>> = [titleSection, actionsBlock]

	if (tier === 'free') {
		blocks.push({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: `_${FREE_TIER_EDIT_HINT}_` }],
		})
	}

	return { blocks }
}

function buildStatusSelect(current: string, statuses: string[]): Record<string, unknown> {
	// Slack requires at least one option and rejects a select whose
	// initial_option value isn't in the options list. If the object's current
	// status isn't in the workspace's configured list (bespoke value written
	// via API), inject it so Slack accepts the payload — the user sees their
	// real status rather than a picker that silently swaps them off it on open.
	const uniqueStatuses = Array.from(new Set(statuses.length > 0 ? statuses : [current]))
	if (!uniqueStatuses.includes(current)) uniqueStatuses.unshift(current)
	const options = uniqueStatuses.map((s) => ({
		text: { type: 'plain_text' as const, text: `◐ ${s}`, emoji: true },
		value: s,
	}))
	return {
		type: 'static_select',
		action_id: 'status_select',
		placeholder: { type: 'plain_text' as const, text: `◐ ${current} ▾`, emoji: true },
		initial_option: {
			text: { type: 'plain_text' as const, text: `◐ ${current}`, emoji: true },
			value: current,
		},
		options,
	}
}

function buildDriverSelect(
	currentDriverId: string | null,
	currentDriverName: string | null,
	drivers: MemberOption[],
): Record<string, unknown> {
	// Empty string is the "Unassigned" sentinel — T6's interactive route
	// treats an empty selected_option.value as a clear-driver.
	const unassigned = {
		text: { type: 'plain_text' as const, text: '👤 Unassigned', emoji: true },
		value: '',
	}
	const memberOptions = drivers.slice(0, MAX_DRIVER_OPTIONS - 1).map((m) => ({
		text: { type: 'plain_text' as const, text: `👤 ${m.name}`, emoji: true },
		value: m.actorId,
	}))
	// If the current driver isn't in the member slice (rare — dropped after
	// leaving the workspace, or beyond MAX_DRIVER_OPTIONS), splice them in so
	// Slack renders the picker without erroring on a missing initial_option.
	if (
		currentDriverId &&
		currentDriverName &&
		!memberOptions.some((o) => o.value === currentDriverId)
	) {
		memberOptions.unshift({
			text: { type: 'plain_text', text: `👤 ${currentDriverName}`, emoji: true },
			value: currentDriverId,
		})
	}
	const options = [unassigned, ...memberOptions]
	const initial = currentDriverId
		? {
				text: {
					type: 'plain_text' as const,
					text: `👤 ${currentDriverName ?? 'Unknown'}`,
					emoji: true,
				},
				value: currentDriverId,
			}
		: unassigned
	const placeholderText = currentDriverId
		? `👤 ${currentDriverName ?? 'Unknown'} ▾`
		: '👤 Unassigned ▾'
	return {
		type: 'static_select',
		action_id: 'driver_select',
		placeholder: { type: 'plain_text' as const, text: placeholderText, emoji: true },
		initial_option: initial,
		options,
	}
}

export interface LinkSharedEvent {
	channel?: string
	message_ts?: string
	unfurl_id?: string
	source?: string
	user?: string
	links?: Array<{ url?: string; domain?: string }>
}

interface WorkspaceLookup {
	statuses: Record<string, string[]>
	members: MemberOption[]
}

/**
 * Batch-fetch a workspace's status settings + up to N drivers. Reused per
 * (workspaceId, cache) inside a single link_shared delivery to avoid re-doing
 * both queries per URL when a message contains several links to the same
 * workspace.
 */
async function fetchWorkspaceLookup(db: Database, workspaceId: string): Promise<WorkspaceLookup> {
	const [wsRow] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const settings = (wsRow?.settings ?? null) as WorkspaceSettings | null
	const statuses = (settings?.statuses ?? {}) as Record<string, string[]>

	const memberRows = await db
		.select({ actorId: actors.id, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(eq(workspaceMembers.workspaceId, workspaceId))
		.limit(MAX_DRIVER_OPTIONS)

	return {
		statuses,
		members: memberRows.map((r) => ({ actorId: r.actorId, name: r.name })),
	}
}

interface SubmitLinkSharedContext {
	db: Database
	integrationId: string
	event: LinkSharedEvent
	teamId: string
	baseUrl?: string
}

/**
 * Handle a single Slack `link_shared` webhook: look up the sharing user's
 * Maskin actor, build a compact unfurl per URL they can see, and submit
 * everything in one `chat.unfurl` call.
 *
 * Silent-skip contract:
 *  - Unlinked sharing user → no unfurls (we can't verify workspace membership).
 *  - URLs the user isn't a member of → dropped from the batch.
 *  - Missing object rows → dropped from the batch.
 *  - Zero valid URLs after filtering → no chat.unfurl call.
 *
 * We treat this as best-effort: Slack surfaces a plain link if we don't
 * unfurl, so a mid-flight failure is graceful. Errors are logged, never
 * thrown — link_shared runs on the async fan-out path so throwing wouldn't
 * even reach the webhook route, but keeping the contract explicit makes the
 * caller obviously safe.
 */
export async function submitLinkSharedUnfurls(ctx: SubmitLinkSharedContext): Promise<void> {
	const { db, integrationId, event, teamId } = ctx
	const baseUrl = ctx.baseUrl ?? frontendBaseUrl()

	const slackUserId = event.user
	const links = event.links ?? []
	if (!slackUserId || links.length === 0) return

	// Parse + de-dupe URLs client-side before any DB work.
	const parsed: Array<{ url: string; parsed: ParsedObjectUrl }> = []
	const seen = new Set<string>()
	for (const link of links.slice(0, MAX_LINKS_PER_EVENT)) {
		if (!link?.url || seen.has(link.url)) continue
		seen.add(link.url)
		const parsedUrl = parseMaskinObjectUrl(link.url, baseUrl)
		if (parsedUrl) parsed.push({ url: link.url, parsed: parsedUrl })
	}
	if (parsed.length === 0) return

	// The sharing user must be linked. This binds "who authorized the
	// unfurl" to a Maskin actor we can then check for workspace membership.
	const [link] = await db
		.select({ actorId: slackUserLinks.actorId })
		.from(slackUserLinks)
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
		.limit(1)
	if (!link) {
		logger.debug('Slack link_shared: sharing user is not linked; skipping unfurls', {
			teamId,
			slackUserId,
		})
		return
	}

	// Resolve the integration + bot token + tier once per delivery.
	const [integration] = await db
		.select({ id: integrations.id, config: integrations.config })
		.from(integrations)
		.where(eq(integrations.id, integrationId))
		.limit(1)
	if (!integration) return

	const { getProvider } = await import('../../registry')
	const tokenManager = new TokenManager()
	let accessToken: string
	try {
		accessToken = await tokenManager.getValidToken(db, integration.id, getProvider('slack'))
	} catch (err) {
		logger.error('Slack link_shared: failed to resolve bot token', {
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
		return
	}

	let tier: SlackTier = 'unknown'
	try {
		tier = await refreshSlackTierIfStale(db, integration, accessToken)
	} catch (err) {
		logger.warn('Slack link_shared: tier refresh threw; defaulting to fail-open', {
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	// Filter parsed URLs to those the linked actor is a member of, then
	// batch-fetch the object rows per workspace.
	const workspaceIds = Array.from(new Set(parsed.map((p) => p.parsed.workspaceId)))
	const memberRows = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, link.actorId),
				inArray(workspaceMembers.workspaceId, workspaceIds),
			),
		)
	const allowedWorkspaces = new Set(memberRows.map((r) => r.workspaceId))
	const authorized = parsed.filter((p) => allowedWorkspaces.has(p.parsed.workspaceId))
	if (authorized.length === 0) return

	// Group by workspace so we can batch object fetches and workspace-lookup
	// queries.
	const byWorkspace = new Map<string, Array<{ url: string; objectId: string }>>()
	for (const { url, parsed: p } of authorized) {
		const list = byWorkspace.get(p.workspaceId) ?? []
		list.push({ url, objectId: p.objectId })
		byWorkspace.set(p.workspaceId, list)
	}

	const unfurls: Record<string, { blocks: Array<Record<string, unknown>> }> = {}
	for (const [workspaceId, list] of byWorkspace) {
		const objectIds = list.map((l) => l.objectId)
		const objectRows = await db
			.select({
				id: objects.id,
				workspaceId: objects.workspaceId,
				type: objects.type,
				title: objects.title,
				status: objects.status,
				driver: objects.driver,
			})
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
		const byId = new Map<string, ObjectRow>()
		for (const o of objectRows) byId.set(o.id, o as ObjectRow)

		const driverIds = Array.from(
			new Set(objectRows.map((o) => o.driver).filter((d): d is string => Boolean(d))),
		)
		const driverNameById = new Map<string, string>()
		if (driverIds.length > 0) {
			const driverRows = await db
				.select({ id: actors.id, name: actors.name })
				.from(actors)
				.where(inArray(actors.id, driverIds))
			for (const d of driverRows) driverNameById.set(d.id, d.name)
		}

		const lookup = await fetchWorkspaceLookup(db, workspaceId)

		for (const { url, objectId } of list) {
			const obj = byId.get(objectId)
			if (!obj) continue
			const statusesForType = lookup.statuses[obj.type] ?? []
			const driverName = obj.driver ? (driverNameById.get(obj.driver) ?? null) : null
			const built = buildCompactUnfurl({
				object: obj,
				driverName,
				statuses: statusesForType,
				drivers: lookup.members,
				tier,
				baseUrl,
			})
			unfurls[url] = built
		}
	}

	if (Object.keys(unfurls).length === 0) return

	try {
		await slackChatUnfurl(accessToken, {
			channel: event.channel,
			ts: event.message_ts,
			unfurl_id: event.unfurl_id,
			source: event.source,
			unfurls,
		})
		logger.info('Slack link_shared: submitted compact unfurls', {
			integrationId,
			teamId,
			slackUserId,
			urlCount: Object.keys(unfurls).length,
			tier,
		})
	} catch (err) {
		logger.warn('Slack link_shared: chat.unfurl failed', {
			integrationId,
			teamId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Fan-out entry point. Called from slackWebhookFanOut when a
 * `slack.link_shared` normalized event arrives. Returns nothing — the
 * normalized event is dropped so the audit log isn't polluted with a row per
 * link expansion (same pattern as `slack.app_home_opened`).
 */
export async function handleLinkShared(
	db: Database,
	integrationId: string,
	normalized: NormalizedEvent,
): Promise<void> {
	const data = normalized.data as Record<string, unknown>
	const event = data.event as LinkSharedEvent | undefined
	const teamId = data.team_id as string | undefined
	if (!event || !teamId) {
		logger.warn('Slack link_shared: payload missing team_id or event', { integrationId })
		return
	}
	await submitLinkSharedUnfurls({ db, integrationId, event, teamId })
}
