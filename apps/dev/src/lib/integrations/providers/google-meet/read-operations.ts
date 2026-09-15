import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import { callGoogleApi } from './client'
import { makeMeetError } from './errors'

const MEET_API_BASE = 'https://meet.googleapis.com/v2'

interface ReadContext {
	db: Database
	workspaceId: string
	/**
	 * Optional actor id. When present, the tools bind to that actor's Meet
	 * integration row; when absent, they fall through to the workspace's
	 * single google-meet row (Meet is workspace-scoped for v1).
	 */
	actorId?: string
}

/**
 * Resolve the OAuth access token that should execute a Meet API call for the
 * given (workspace, optional linked meeting). The host-actor resolution order:
 *
 *   1. Explicit actor_id.
 *   2. linked meeting's metadata.meeting_owner → workspace actor.
 *   3. Workspace's google-meet row (single-host case).
 *
 * Wrong-actor 403 → MEETING_NOT_OWNED_BY_ACTOR, surfaced via the errors module.
 */
export async function resolveHostToken(
	ctx: ReadContext,
	linkedMeetingId?: string,
): Promise<string> {
	// (2) — resolve host actor via linked meeting object.
	if (!ctx.actorId && linkedMeetingId) {
		const [meeting] = await ctx.db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(and(eq(objects.id, linkedMeetingId), eq(objects.workspaceId, ctx.workspaceId)))
			.limit(1)
		const owner = (meeting?.metadata as Record<string, unknown> | null)?.meeting_owner
		if (typeof owner === 'string' && owner.length > 0) {
			ctx.actorId = owner
		}
	}

	// (3) — workspace-scoped row (Meet is not on actorScopedProviders in v1).
	const rows = await ctx.db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, ctx.workspaceId),
				eq(integrations.provider, 'google-meet'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	const row = rows[0]
	if (!row) {
		throw makeMeetError(
			'INTEGRATION_MISSING',
			'No active google-meet integration is connected on this workspace.',
			{ hint: 'Connect Google Meet under Settings → Integrations before calling this tool.' },
		)
	}
	const tokenManager = new TokenManager()
	try {
		return await tokenManager.getValidToken(ctx.db, row.id, getProvider('google-meet'))
	} catch (err) {
		logger.warn('Meet read-tool token fetch failed', {
			workspaceId: ctx.workspaceId,
			integrationId: row.id,
			error: err instanceof Error ? err.message : String(err),
		})
		throw makeMeetError(
			'RECONSENT_REQUIRED',
			'Failed to mint a valid Meet access token — the workspace must reconnect Google Meet.',
		)
	}
}

/**
 * Cross-workspace isolation guard: if a caller in workspace B references a
 * Meet resource whose linked meeting belongs to workspace A, surface
 * MEETING_NOT_OWNED_BY_ACTOR rather than let the read leak into A.
 *
 * Called explicitly by the tools that accept a conference-record identifier.
 */
export async function assertConferenceOwnedByWorkspace(
	ctx: ReadContext,
	conferenceRecordName: string,
): Promise<void> {
	const rows = await ctx.db
		.select({ id: objects.id, workspaceId: objects.workspaceId })
		.from(objects)
		.where(
			and(
				eq(objects.type, 'meeting'),
				sql`${objects.metadata}->>'google_meet_conference_record_name' = ${conferenceRecordName}`,
			),
		)
	if (rows.length === 0) return // no linked meeting anywhere — the host token will resolve ownership.
	if (!rows.some((r) => r.workspaceId === ctx.workspaceId)) {
		throw makeMeetError(
			'MEETING_NOT_OWNED_BY_ACTOR',
			'The referenced Meet conference is not owned by any actor in this workspace.',
		)
	}
}

async function fetchPages<TItem>(
	url: string,
	accessToken: string,
	itemKey: string,
	extraQuery?: Record<string, string | undefined>,
	maxPages = 20,
): Promise<TItem[]> {
	const out: TItem[] = []
	let pageToken: string | undefined
	for (let i = 0; i < maxPages; i++) {
		const query: Record<string, string | undefined> = { ...(extraQuery ?? {}) }
		if (pageToken) query.pageToken = pageToken
		const page = await callGoogleApi<Record<string, unknown>>(url, accessToken, { query })
		const items = (page[itemKey] as TItem[] | undefined) ?? []
		out.push(...items)
		const next = page.nextPageToken
		if (typeof next !== 'string' || next.length === 0) return out
		pageToken = next
	}
	logger.warn('Meet read pagination exceeded safety bound', { url })
	return out
}

// ── Tool implementations ────────────────────────────────────────────────────

export interface ListConferenceRecordsInput {
	space_name?: string
	start_time_after?: string
	page_size?: number
}

export async function listConferenceRecords(
	ctx: ReadContext,
	input: ListConferenceRecordsInput,
): Promise<{ conference_records: unknown[] }> {
	const accessToken = await resolveHostToken(ctx)
	const filterParts: string[] = []
	if (input.space_name) filterParts.push(`space.name = "${input.space_name}"`)
	if (input.start_time_after) filterParts.push(`end_time > "${input.start_time_after}"`)
	const query: Record<string, string | undefined> = {
		filter: filterParts.length > 0 ? filterParts.join(' AND ') : undefined,
		pageSize: input.page_size ? String(input.page_size) : undefined,
	}
	const page = await callGoogleApi<Record<string, unknown>>(
		`${MEET_API_BASE}/conferenceRecords`,
		accessToken,
		{ query },
	)
	return {
		conference_records: (page.conferenceRecords as unknown[] | undefined) ?? [],
	}
}

export interface GetConferenceRecordInput {
	conference_record_name: string
}

export async function getConferenceRecord(
	ctx: ReadContext,
	input: GetConferenceRecordInput,
): Promise<unknown> {
	await assertConferenceOwnedByWorkspace(ctx, input.conference_record_name)
	const accessToken = await resolveHostToken(ctx)
	return callGoogleApi<unknown>(
		`${MEET_API_BASE}/${input.conference_record_name}`,
		accessToken,
	)
}

export interface ListParticipantsInput {
	conference_record_name: string
	page_size?: number
}

export async function listParticipants(
	ctx: ReadContext,
	input: ListParticipantsInput,
): Promise<{ participants: unknown[] }> {
	await assertConferenceOwnedByWorkspace(ctx, input.conference_record_name)
	const accessToken = await resolveHostToken(ctx)
	const participants = await fetchPages<unknown>(
		`${MEET_API_BASE}/${input.conference_record_name}/participants`,
		accessToken,
		'participants',
		{ pageSize: input.page_size ? String(input.page_size) : undefined },
	)
	return { participants }
}

export interface GetTranscriptEntriesInput {
	conference_record_name: string
	page_size?: number
}

export async function getTranscriptEntries(
	ctx: ReadContext,
	input: GetTranscriptEntriesInput,
): Promise<{ transcript: unknown; entries: unknown[] }> {
	await assertConferenceOwnedByWorkspace(ctx, input.conference_record_name)
	const accessToken = await resolveHostToken(ctx)
	// List transcripts on the record, walk entries for the first one (Meet
	// currently emits a single transcript resource per conference record).
	const transcripts = await fetchPages<{ name: string }>(
		`${MEET_API_BASE}/${input.conference_record_name}/transcripts`,
		accessToken,
		'transcripts',
		{ pageSize: '5' },
	)
	const transcript = transcripts[0]
	if (!transcript) {
		throw makeMeetError(
			'ARTEFACT_PENDING',
			'No transcript is available on this conference record yet.',
			{
				hint: 'Meet transcripts are generated asynchronously — try again in a few minutes, or run the sweep_pending_transcripts reconciler.',
			},
		)
	}
	const entries = await fetchPages<unknown>(
		`${MEET_API_BASE}/${transcript.name}/entries`,
		accessToken,
		'transcriptEntries',
		{ pageSize: input.page_size ? String(input.page_size) : undefined },
	)
	return { transcript, entries }
}

export interface ListRecordingsInput {
	conference_record_name: string
}

export async function listRecordings(
	ctx: ReadContext,
	input: ListRecordingsInput,
): Promise<{ recordings: unknown[] }> {
	await assertConferenceOwnedByWorkspace(ctx, input.conference_record_name)
	const accessToken = await resolveHostToken(ctx)
	const recordings = await fetchPages<unknown>(
		`${MEET_API_BASE}/${input.conference_record_name}/recordings`,
		accessToken,
		'recordings',
	)
	return { recordings }
}
