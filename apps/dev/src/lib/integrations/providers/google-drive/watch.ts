import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import type { PostInstallContext, PreDisconnectContext } from '../../types'
import { computeChannelToken } from './channel-token'
import { type DriveClient, createDefaultDriveClient } from './client'
import { GOOGLE_DRIVE_PROVIDER } from './token'

export const DRIVE_EVENT_TYPES = ['created', 'updated', 'deleted', 'trashed'] as const
export type DriveEventType = (typeof DRIVE_EVENT_TYPES)[number]

/** One entry of config.drive.watchedFolders (the shape the folder-watches list reads). */
export interface WatchedFolderEntry {
	folderId: string
	name: string
	/** Ancestor names, slash-separated, best effort. */
	path?: string
	addedAt: string
	lastFiredAt?: string
	/** Absent means all four event types. */
	eventTypes?: DriveEventType[]
}

/** The config.drive block on a google-drive integrations row. */
export interface DriveConfigBlock {
	peopleId?: string
	channelId?: string
	channelResourceId?: string
	channelExpiresAt?: number
	channelWebhookToken?: string
	startPageToken?: string
	watchedFolders?: WatchedFolderEntry[]
}

export interface DriveIntegrationConfig extends IntegrationConfig {
	drive?: DriveConfigBlock
}

/** The config.drive keys that belong to one notification channel, never to the row. */
const DRIVE_CHANNEL_KEYS = [
	'channelId',
	'channelResourceId',
	'channelExpiresAt',
	'channelWebhookToken',
	'startPageToken',
] as const satisfies readonly (keyof DriveConfigBlock)[]

/**
 * What a same-account reconnect keeps of the prior row's config.drive: every key
 * except the channel fields, so keys added to the block later survive without
 * touching this list. The old channel was stopped at disconnect and postInstall
 * opens a new one, so the channel fields and the change cursor must not carry.
 * Returns undefined when nothing is left, so a row that never had a drive block
 * (or only channel fields) does not gain an empty one.
 */
export function carriedDriveConfig(
	prior: DriveIntegrationConfig | null | undefined,
): DriveConfigBlock | undefined {
	const kept: Record<string, unknown> = { ...prior?.drive }
	for (const key of DRIVE_CHANNEL_KEYS) delete kept[key]
	return Object.keys(kept).length > 0 ? (kept as DriveConfigBlock) : undefined
}

/** Path the channel delivers to: the webhook app is mounted at /api/webhooks. */
export const DRIVE_WEBHOOK_PATH = '/api/webhooks/google-drive'

const DAY_MS = 24 * 60 * 60 * 1000
/** Channel lifetime we ask for. Overridable until the S13 smoke records the real cap. */
const DEFAULT_CHANNEL_TTL_MS = 6 * DAY_MS

export function readPositiveIntEnv(name: string, fallback: number): number {
	const parsed = Number(process.env[name])
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function channelTtlMs(): number {
	return readPositiveIntEnv('GOOGLE_DRIVE_CHANNEL_TTL_MS', DEFAULT_CHANNEL_TTL_MS)
}

function webhookAddress(): string {
	const origin = process.env.MASKIN_PUBLIC_URL
	if (!origin) throw new Error('MASKIN_PUBLIC_URL env var is required for google-drive')
	return `${origin.replace(/\/$/, '')}${DRIVE_WEBHOOK_PATH}`
}

/**
 * Merge fields into config.drive without touching the other keys of the row's
 * config (system_actor_id, watchedFolders, ...). Callers pass only the fields
 * they own, so a concurrent fan-out advancing startPageToken is never rewound.
 */
export async function mergeDriveConfig(
	db: Database,
	integrationId: string,
	fields: Partial<DriveConfigBlock>,
): Promise<void> {
	const driveSubobject = JSON.stringify(fields)
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{drive}', COALESCE(${integrations.config}->'drive', '{}'::jsonb) || ${driveSubobject}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))
}

async function loadDriveRow(db: Database, integrationId: string) {
	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(eq(integrations.id, integrationId), eq(integrations.provider, GOOGLE_DRIVE_PROVIDER)),
		)
		.limit(1)
	return row
}

/** Best-effort channels.stop: a channel that is already gone (404) is the goal state. */
async function stopChannelQuietly(
	client: DriveClient,
	accessToken: string,
	integrationId: string,
	drive: DriveConfigBlock | undefined,
): Promise<void> {
	if (!drive?.channelId || !drive.channelResourceId) return
	try {
		await client.stopChannel(accessToken, {
			id: drive.channelId,
			resourceId: drive.channelResourceId,
		})
		logger.info('Google Drive channel stopped', { integrationId, channelId: drive.channelId })
	} catch (err) {
		logger.warn('Google Drive channel stop failed (continuing)', {
			integrationId,
			channelId: drive.channelId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Open a fresh changes.watch channel for the row and persist it, then stop the
 * row's previous channel. Used for the first channel (postInstall), a reconnect
 * and every renewal, so every one of them mints a new channel id.
 *
 * startPageToken is carried across the swap: the new channel starts from the
 * cursor the old one had, so nothing that changed during the swap is missed. It
 * is only written when the row had none, so a fan-out that advanced it in the
 * meantime is never rewound. watchedFolders are not touched.
 *
 * The new channel is opened and saved before the old one is stopped, so there is
 * no window with no channel; a delivery on the old id after the swap no longer
 * matches a row and is dropped (the cursor means the new channel's next
 * delivery still picks the change up).
 */
async function rotateChannel(
	db: Database,
	row: typeof integrations.$inferSelect,
	accessToken: string,
	client: DriveClient,
): Promise<DriveConfigBlock> {
	const drive = (row.config as DriveIntegrationConfig | null)?.drive
	const hadCursor = Boolean(drive?.startPageToken)
	const startPageToken = drive?.startPageToken ?? (await client.getStartPageToken(accessToken))

	const channelId = randomUUID()
	const channelWebhookToken = computeChannelToken(channelId)
	const requestedExpiry = Date.now() + channelTtlMs()
	const watch = await client.watchChanges(accessToken, {
		pageToken: startPageToken,
		channelId,
		address: webhookAddress(),
		token: channelWebhookToken,
		expiration: requestedExpiry,
	})
	const grantedExpiry = Number(watch.expiration)
	const channelExpiresAt =
		Number.isFinite(grantedExpiry) && grantedExpiry > 0 ? grantedExpiry : requestedExpiry
	// S13: Google may clamp the requested expiry. Record the gap so the renewer
	// window can be sized from what Google really grants.
	if (channelExpiresAt < requestedExpiry - DAY_MS) {
		logger.warn('Google Drive clamped the requested channel expiry', {
			integrationId: row.id,
			requestedExpiry,
			grantedExpiry: channelExpiresAt,
		})
	}

	const fields: Partial<DriveConfigBlock> = {
		channelId,
		channelResourceId: watch.resourceId,
		channelExpiresAt,
		channelWebhookToken,
		...(hadCursor ? {} : { startPageToken }),
	}
	await mergeDriveConfig(db, row.id, fields)
	logger.info('Google Drive channel opened', {
		integrationId: row.id,
		channelId,
		channelExpiresAt,
	})

	await stopChannelQuietly(client, accessToken, row.id, drive)
	return { ...drive, ...fields }
}

/**
 * postInstall step: open the row's changes.watch channel and seed the change
 * cursor. A failure throws so the generic callback flips the row to error
 * instead of leaving a connected row with no channel.
 */
export async function setupDriveWatch(
	ctx: PostInstallContext,
	client: DriveClient = createDefaultDriveClient(),
): Promise<void> {
	const db = ctx.db as Database
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) throw new Error('Google Drive watch: no access token in credentials')
	const row = await loadDriveRow(db, ctx.integrationId)
	if (!row) throw new Error(`Integration ${ctx.integrationId} not found`)
	await rotateChannel(db, row, accessToken, client)
}

/**
 * Renewal and repair: Drive channels have no reactivate, so renewing is a fresh
 * changes.watch plus channels.stop of the old one, with the cursor carried over.
 * Also opens the first channel for a row that has none.
 */
export async function renewDriveWatch(
	db: Database,
	integrationId: string,
	client: DriveClient = createDefaultDriveClient(),
): Promise<DriveConfigBlock> {
	const row = await loadDriveRow(db, integrationId)
	if (!row) throw new Error(`Integration ${integrationId} not found`)
	const accessToken = await new TokenManager().getValidToken(
		db,
		integrationId,
		getProvider(GOOGLE_DRIVE_PROVIDER),
	)
	return rotateChannel(db, row, accessToken, client)
}

/** True when the row has a channel that is still live for at least `withinMs`. */
export function hasLiveChannel(drive: DriveConfigBlock | undefined, withinMs = 0): boolean {
	return Boolean(
		drive?.channelId &&
			drive.channelResourceId &&
			(drive.channelExpiresAt ?? 0) > Date.now() + withinMs,
	)
}

/**
 * preDisconnect: stop the row's channel so Google stops delivering. Best effort:
 * any failure is logged and disconnect continues. It runs while the row's token
 * is still readable, since channels.stop needs a live token. The Google grant
 * itself is left alone: other workspaces and Google providers share it.
 */
export async function stopDriveChannel(
	ctx: PreDisconnectContext,
	client: DriveClient = createDefaultDriveClient(),
): Promise<void> {
	try {
		const db = ctx.db as Database
		const row = await loadDriveRow(db, ctx.integrationId)
		const drive = (row?.config as DriveIntegrationConfig | null)?.drive
		if (!drive?.channelId) return
		const accessToken = await new TokenManager().getValidToken(
			db,
			ctx.integrationId,
			getProvider(GOOGLE_DRIVE_PROVIDER),
		)
		await stopChannelQuietly(client, accessToken, ctx.integrationId, drive)
	} catch (err) {
		logger.warn('Google Drive channel stop skipped (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
