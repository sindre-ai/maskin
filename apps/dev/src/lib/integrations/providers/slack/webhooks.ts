import type { CustomEventNormalizer } from '../../types'

const eventMapping: Record<string, { entityType: string; action: string }> = {
	message: { entityType: 'slack.message', action: 'created' },
	app_mention: { entityType: 'slack.app_mention', action: 'created' },
	reaction_added: { entityType: 'slack.reaction', action: 'added' },
	reaction_removed: { entityType: 'slack.reaction', action: 'removed' },
	channel_created: { entityType: 'slack.channel', action: 'created' },
	channel_deleted: { entityType: 'slack.channel', action: 'deleted' },
	channel_rename: { entityType: 'slack.channel', action: 'renamed' },
	member_joined_channel: { entityType: 'slack.member', action: 'joined' },
}

/**
 * Normalize Slack event payloads.
 *
 * Slack wraps events in an outer envelope:
 * { type: "event_callback", team_id: "T...", event: { type: "message", ... } }
 *
 * The inner event.type determines the normalized entity type and action.
 */
export const slackEventNormalizer: CustomEventNormalizer = (payload, _headers) => {
	const data = payload as Record<string, unknown>

	if (data.type !== 'event_callback') return null

	const teamId = data.team_id as string
	if (!teamId) return null

	const event = data.event as Record<string, unknown>
	if (!event) return null

	const eventType = event.type as string
	const mapped = eventMapping[eventType]
	if (!mapped) return null

	return {
		entityType: mapped.entityType,
		action: mapped.action,
		installationId: teamId,
		data: data,
	}
}
