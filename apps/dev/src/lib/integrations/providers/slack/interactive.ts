import type { Database } from '@maskin/db'
import {
	events,
	actors,
	objects,
	slackUserLinks,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { WorkspaceSettings } from '../../../types'

const RESPONSE_TIMEOUT_MS = 3_000
const UNLINKED_ACCOUNT_MESSAGE =
	'Link your Maskin account to make edits from Slack. Open Maskin → Settings → Slack to connect.'
const INVALID_BLOCK_MESSAGE = 'This action is no longer valid. Refresh the link to try again.'
const OBJECT_NOT_FOUND_MESSAGE = 'That Maskin object is no longer reachable from this workspace.'
const FORBIDDEN_MESSAGE = "You don't have access to that Maskin workspace."
const INVALID_STATUS_MESSAGE = (status: string, valid: string[]) =>
	`Status \`${status}\` isn't valid. Allowed: ${valid.join(', ')}.`

export const SUPPORTED_ACTION_IDS = ['status_select', 'driver_select'] as const
export type SupportedActionId = (typeof SUPPORTED_ACTION_IDS)[number]

/**
 * Block-level identifier the unfurl pipeline (T5) emits on every editable
 * row. The interactive route round-trips this back through Slack to resolve
 * the maskin object without trusting any user-supplied value other than the
 * UUIDs themselves (which are then re-validated against workspace
 * membership).
 *
 * Format: `obj:{workspaceId}:{objectId}` — both UUIDs.
 */
const BLOCK_ID_PREFIX = 'obj:'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildObjectBlockId(workspaceId: string, objectId: string): string {
	return `${BLOCK_ID_PREFIX}${workspaceId}:${objectId}`
}

interface ParsedBlockId {
	workspaceId: string
	objectId: string
}

function parseObjectBlockId(blockId: unknown): ParsedBlockId | null {
	if (typeof blockId !== 'string' || !blockId.startsWith(BLOCK_ID_PREFIX)) return null
	const [workspaceId, objectId] = blockId.slice(BLOCK_ID_PREFIX.length).split(':')
	if (!workspaceId || !objectId) return null
	if (!UUID_RE.test(workspaceId) || !UUID_RE.test(objectId)) return null
	return { workspaceId, objectId }
}

interface SlackUser {
	id?: string
}

interface SlackTeam {
	id?: string
}

interface SlackOption {
	value?: string
}

interface SlackBlockAction {
	type?: string
	action_id?: string
	block_id?: string
	selected_option?: SlackOption | null
}

export interface SlackBlockActionsPayload {
	type: 'block_actions'
	user?: SlackUser
	team?: SlackTeam
	trigger_id?: string
	response_url?: string
	actions?: SlackBlockAction[]
}

interface SlackInteractivePayload {
	type?: string
	user?: SlackUser
	team?: SlackTeam
	trigger_id?: string
	response_url?: string
	actions?: SlackBlockAction[]
}

/**
 * Parse a Slack interactivity request body.
 *
 * Slack POSTs interactive payloads as `application/x-www-form-urlencoded`
 * with a single `payload=<json>` field. Returning `null` here is the
 * route's signal to ack 200 without doing work — never a 4xx, because
 * 4xx triggers Slack retries that would never succeed.
 */
export function parseSlackInteractivePayload(rawBody: string): SlackInteractivePayload | null {
	try {
		const params = new URLSearchParams(rawBody)
		const payload = params.get('payload')
		if (!payload) return null
		const parsed = JSON.parse(payload) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		return parsed as SlackInteractivePayload
	} catch (err) {
		logger.warn('Failed to parse Slack interactive payload', {
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/**
 * Extract a stable dedup key for `webhook_deliveries`. Slack retries
 * interactive POSTs on non-2xx; `trigger_id` is unique per user
 * interaction so we use `{team_id}:{trigger_id}` as the external id.
 * Returns null when either field is missing (caller still processes,
 * just without dedup).
 */
export function slackInteractiveDeliveryId(payload: SlackInteractivePayload): string | null {
	const teamId = payload.team?.id
	const triggerId = payload.trigger_id
	if (!teamId || !triggerId) return null
	return `${teamId}:${triggerId}`
}

/**
 * POST to a Slack `response_url` as `response_type: ephemeral` so the
 * confirmation is only visible to the clicker — channel-wide spam on
 * every edit was the failure mode this task is closing.
 *
 * Fail-quietly: a logged warning is enough — Slack already showed the
 * user that their selection landed, and the maskin object update
 * committed server-side regardless.
 */
export async function sendEphemeralResponse(
	responseUrl: string,
	body: { text: string },
): Promise<void> {
	try {
		const res = await fetch(responseUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ response_type: 'ephemeral', ...body }),
			signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
		})
		if (!res.ok) {
			logger.warn('Slack response_url returned non-2xx', { status: res.status })
		}
	} catch (err) {
		logger.warn('Slack response_url POST failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export interface HandleResult {
	/** Whether downstream work committed a change to a maskin object. */
	updated: boolean
	/** Resolved Maskin actor id, when a Slack-user link existed. */
	actorId?: string
	/** Maskin workspace the change landed in. */
	workspaceId?: string
	/** Maskin object that received the change. */
	objectId?: string
}

/**
 * Resolve the Slack user → Maskin actor for the given action and apply
 * the change to the addressed object. Reply with an ephemeral
 * confirmation via `response_url`.
 *
 * Designed for an at-most-once call site: the caller is responsible for
 * webhook_deliveries dedup, so this function does not check for replay.
 */
export async function handleSlackInteractivePayload(
	db: Database,
	payload: SlackInteractivePayload,
): Promise<HandleResult> {
	if (payload.type !== 'block_actions') return { updated: false }

	const action = (payload.actions ?? [])[0]
	if (!action || action.type !== 'static_select') return { updated: false }
	if (!isSupportedActionId(action.action_id)) return { updated: false }

	const responseUrl = payload.response_url

	const block = parseObjectBlockId(action.block_id)
	if (!block) {
		if (responseUrl) await sendEphemeralResponse(responseUrl, { text: INVALID_BLOCK_MESSAGE })
		return { updated: false }
	}

	const teamId = payload.team?.id
	const slackUserId = payload.user?.id
	if (!teamId || !slackUserId) return { updated: false }

	const [link] = await db
		.select()
		.from(slackUserLinks)
		.where(and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
		.limit(1)

	if (!link) {
		if (responseUrl) await sendEphemeralResponse(responseUrl, { text: UNLINKED_ACCOUNT_MESSAGE })
		return { updated: false }
	}

	// The acting actor must be a member of the target workspace.
	// Without this check, a linked user could PATCH any object whose UUID
	// they can guess (the block_id is signed by Slack but not by us).
	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.actorId, link.actorId),
				eq(workspaceMembers.workspaceId, block.workspaceId),
			),
		)
		.limit(1)

	if (!member) {
		if (responseUrl) await sendEphemeralResponse(responseUrl, { text: FORBIDDEN_MESSAGE })
		return { updated: false, actorId: link.actorId }
	}

	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, block.objectId), eq(objects.workspaceId, block.workspaceId)))
		.limit(1)

	if (!object) {
		if (responseUrl) await sendEphemeralResponse(responseUrl, { text: OBJECT_NOT_FOUND_MESSAGE })
		return { updated: false, actorId: link.actorId, workspaceId: block.workspaceId }
	}

	const selectedValue = action.selected_option?.value
	if (!selectedValue)
		return { updated: false, actorId: link.actorId, workspaceId: block.workspaceId }

	const actionId = action.action_id as SupportedActionId

	if (actionId === 'status_select') {
		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, block.workspaceId))
			.limit(1)

		const settings = (workspace?.settings ?? null) as WorkspaceSettings | null
		const validStatuses = settings?.statuses?.[object.type]
		if (validStatuses && !validStatuses.includes(selectedValue)) {
			if (responseUrl) {
				await sendEphemeralResponse(responseUrl, {
					text: INVALID_STATUS_MESSAGE(selectedValue, validStatuses),
				})
			}
			return {
				updated: false,
				actorId: link.actorId,
				workspaceId: block.workspaceId,
				objectId: object.id,
			}
		}

		if (object.status === selectedValue) {
			if (responseUrl) {
				await sendEphemeralResponse(responseUrl, {
					text: `Status is already \`${selectedValue}\`.`,
				})
			}
			return {
				updated: false,
				actorId: link.actorId,
				workspaceId: block.workspaceId,
				objectId: object.id,
			}
		}

		await db
			.update(objects)
			.set({ status: selectedValue, updatedAt: new Date() })
			.where(eq(objects.id, object.id))

		await db.insert(events).values({
			workspaceId: object.workspaceId,
			actorId: link.actorId,
			action: 'status_changed',
			entityType: object.type,
			entityId: object.id,
			data: {
				previous: object,
				updated: { ...object, status: selectedValue },
				source: 'slack_interactive',
			},
		})

		logger.info('Slack interactive: object status updated', {
			workspaceId: object.workspaceId,
			objectId: object.id,
			actorId: link.actorId,
			previousStatus: object.status,
			nextStatus: selectedValue,
		})

		if (responseUrl) {
			await sendEphemeralResponse(responseUrl, {
				text: `Status set to \`${selectedValue}\`.`,
			})
		}

		return {
			updated: true,
			actorId: link.actorId,
			workspaceId: block.workspaceId,
			objectId: object.id,
		}
	}

	// driver_select: empty string clears the driver, otherwise resolve the actor.
	let nextDriverId: string | null = null
	if (selectedValue !== '') {
		if (!UUID_RE.test(selectedValue)) {
			if (responseUrl) {
				await sendEphemeralResponse(responseUrl, { text: INVALID_BLOCK_MESSAGE })
			}
			return {
				updated: false,
				actorId: link.actorId,
				workspaceId: block.workspaceId,
				objectId: object.id,
			}
		}
		const [driverActor] = await db
			.select({ id: actors.id })
			.from(actors)
			.where(eq(actors.id, selectedValue))
			.limit(1)
		if (!driverActor) {
			if (responseUrl) {
				await sendEphemeralResponse(responseUrl, { text: 'That assignee is no longer available.' })
			}
			return {
				updated: false,
				actorId: link.actorId,
				workspaceId: block.workspaceId,
				objectId: object.id,
			}
		}
		const [driverMember] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.actorId, driverActor.id),
					eq(workspaceMembers.workspaceId, block.workspaceId),
				),
			)
			.limit(1)
		if (!driverMember) {
			if (responseUrl) {
				await sendEphemeralResponse(responseUrl, { text: 'That assignee is no longer available.' })
			}
			return {
				updated: false,
				actorId: link.actorId,
				workspaceId: block.workspaceId,
				objectId: object.id,
			}
		}
		nextDriverId = driverActor.id
	}

	if (object.driver === nextDriverId) {
		if (responseUrl) {
			await sendEphemeralResponse(responseUrl, {
				text: nextDriverId ? 'Assignee unchanged.' : 'Already unassigned.',
			})
		}
		return {
			updated: false,
			actorId: link.actorId,
			workspaceId: block.workspaceId,
			objectId: object.id,
		}
	}

	await db
		.update(objects)
		.set({ driver: nextDriverId, updatedAt: new Date() })
		.where(eq(objects.id, object.id))

	await db.insert(events).values({
		workspaceId: object.workspaceId,
		actorId: link.actorId,
		action: 'updated',
		entityType: object.type,
		entityId: object.id,
		data: {
			previous: object,
			updated: { ...object, driver: nextDriverId },
			source: 'slack_interactive',
		},
	})

	logger.info('Slack interactive: object driver updated', {
		workspaceId: object.workspaceId,
		objectId: object.id,
		actorId: link.actorId,
		previousDriver: object.driver,
		nextDriver: nextDriverId,
	})

	if (responseUrl) {
		await sendEphemeralResponse(responseUrl, {
			text: nextDriverId ? 'Assignee updated.' : 'Unassigned.',
		})
	}

	return {
		updated: true,
		actorId: link.actorId,
		workspaceId: block.workspaceId,
		objectId: object.id,
	}
}

function isSupportedActionId(actionId: unknown): actionId is SupportedActionId {
	return (
		typeof actionId === 'string' && (SUPPORTED_ACTION_IDS as readonly string[]).includes(actionId)
	)
}
