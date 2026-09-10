import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { IntegrationAuthRevokedError } from '../../errors'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import { MeetToolError } from './errors'

/**
 * Resolve the OAuth access token for a Meet MCP tool call.
 *
 * Resolution order (per task 824f · acceptance criteria + Reshape spec §5):
 *   1. Explicit `actor_id` — the caller passed the actor whose token to use.
 *   2. Linked meeting object's `metadata.meeting_owner` — the owner of the
 *      meeting the tool is acting on. Only used when `opts.meetingObjectId`
 *      is set (read-path callers pass it; write-path callers usually skip).
 *   3. Caller's actor (i.e. the actor whose API key drove the request).
 *
 * The resolved actor becomes the token owner. The workspace is always the
 * gate: the resolver never returns a token from a different workspace than
 * `workspaceId`, even if the same host is connected in multiple workspaces.
 *
 * On a wrong-actor 403 later in the pipeline (Google refuses a resource this
 * token can't touch), the write-path caller should raise
 * `MEETING_NOT_OWNED_BY_ACTOR` — this resolver only picks WHICH token to try,
 * it does not authorise the resource.
 */
export interface ResolveTokenOptions {
	db: Database
	workspaceId: string
	callerActorId: string
	explicitActorId?: string
	meetingObjectId?: string
}

export interface ResolvedToken {
	accessToken: string
	integrationId: string
	resolvedActorId: string
	externalId: string | null
}

export async function resolveMeetToken(opts: ResolveTokenOptions): Promise<ResolvedToken> {
	const chosenActorId = await pickActorId(opts)

	const provider = getProvider('google-meet')
	const [row] = await opts.db
		.select({
			id: integrations.id,
			externalId: integrations.externalId,
			actorId: integrations.actorId,
			status: integrations.status,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, opts.workspaceId),
				eq(integrations.provider, 'google-meet'),
			),
		)
		.limit(1)

	if (!row) {
		throw new MeetToolError(
			'RECONSENT_REQUIRED',
			'This workspace has not connected Google Meet.',
			{
				hint: 'Ask a workspace admin to connect Google Meet from Settings → Integrations before calling this tool.',
			},
		)
	}

	if (row.status !== 'active') {
		throw new MeetToolError(
			'RECONSENT_REQUIRED',
			`Google Meet integration is not active (status: ${row.status}).`,
			{
				hint: 'The host must reconnect Google — the stored grant is no longer usable.',
			},
		)
	}

	try {
		const accessToken = await new TokenManager().getValidToken(opts.db, row.id, provider)
		return {
			accessToken,
			integrationId: row.id,
			resolvedActorId: chosenActorId,
			externalId: row.externalId ?? null,
		}
	} catch (err) {
		if (err instanceof IntegrationAuthRevokedError) {
			throw new MeetToolError(
				'RECONSENT_REQUIRED',
				'Stored Google Meet credentials were revoked upstream.',
				{
					hint: 'Ask the meeting host to reconnect Google — the refresh token is no longer valid.',
				},
			)
		}
		throw err
	}
}

async function pickActorId(opts: ResolveTokenOptions): Promise<string> {
	if (opts.explicitActorId) return opts.explicitActorId

	if (opts.meetingObjectId) {
		// `metadata.meeting_owner` is either a bare actor UUID or the same
		// wrapped in a workspace-field envelope. Both shapes flatten to a
		// string via `jsonb ->>` when present; a missing key returns NULL.
		const [meeting] = await opts.db
			.select({
				owner: sql<string | null>`${objects.metadata} ->> 'meeting_owner'`,
			})
			.from(objects)
			.where(and(eq(objects.id, opts.meetingObjectId), eq(objects.workspaceId, opts.workspaceId)))
			.limit(1)
		if (meeting?.owner) return meeting.owner
	}

	return opts.callerActorId
}
