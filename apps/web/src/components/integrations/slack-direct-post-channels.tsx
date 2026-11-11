import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { SearchableMultiSelect } from '@/components/triggers/searchable-multi-select'
import { useCanWrite } from '@/hooks/use-can-write'
import { useSetSlackDirectPostChannels, useSlackConversations } from '@/hooks/use-integrations'
import type { IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

/** Key on the Slack integration's config that holds the allowlist (set by the server). */
const DIRECT_POST_CHANNELS_KEY = 'slack_direct_post_channels'

const CHANNEL_TYPES = ['public_channel', 'private_channel']

/** The saved channel ids, or undefined when nobody has saved a list yet. */
export function savedDirectPostChannels(config: Record<string, unknown>): string[] | undefined {
	const stored = config[DIRECT_POST_CHANNELS_KEY]
	if (!Array.isArray(stored)) return undefined
	return stored.filter((id): id is string => typeof id === 'string')
}

/**
 * Which Slack channels agents may post to without a person approving a draft. Every other
 * post waits for approval. The list is saved on the Slack connection, so a change applies to
 * the next post. Only a human admin or owner can change it, the same rule the server enforces.
 */
export function SlackDirectPostChannels({
	integration,
	workspaceId,
}: {
	integration: IntegrationResponse
	workspaceId: string
}) {
	const { workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const me = getStoredActor()
	const canEdit =
		canWrite && me?.type === 'human' && (workspace.role === 'owner' || workspace.role === 'admin')

	const {
		data: conversations,
		isLoading,
		isError,
	} = useSlackConversations(integration.id, workspaceId, CHANNEL_TYPES)
	const save = useSetSlackDirectPostChannels(workspaceId)

	const items = useMemo(
		() =>
			(conversations ?? [])
				.map((c) => ({
					id: c.id,
					label: `#${c.name || c.id}`,
					hint: c.is_private ? 'private' : undefined,
				}))
				.sort((a, b) => a.label.localeCompare(b.label)),
		[conversations],
	)

	const saved = savedDirectPostChannels(integration.config)
	// While a save is in flight, show what was just picked rather than the old list.
	const selected = save.isPending ? (save.variables ?? saved ?? []) : (saved ?? [])

	return (
		<div className="mt-1 space-y-2 border-t border-border pt-2">
			<div>
				<p className="settings-label text-xs">Direct posting</p>
				<p className="text-xs text-muted-foreground">
					{saved === undefined
						? 'No channels yet: every Slack post waits for a person to approve it.'
						: selected.length === 0
							? 'No channels: every Slack post waits for a person to approve it.'
							: 'Agents post to the checked channels without approval. Everywhere else a person approves each message.'}
				</p>
			</div>
			<ViewerTooltip className="flex">
				<SearchableMultiSelect
					items={items}
					selectedIds={selected}
					onChange={(ids) => save.mutate(ids)}
					placeholder="Search channels…"
					emptyText="No channels found. The bot lists public channels and private ones it was invited to."
					loading={isLoading}
					disabled={!canEdit || save.isPending}
				/>
			</ViewerTooltip>
			{isError && (
				<p className="text-xs text-destructive">
					Couldn't list Slack channels. Reconnect Slack and try again.
				</p>
			)}
			{!canEdit && (
				<p className="text-xs text-muted-foreground">
					Only a workspace admin or owner can change which channels agents post to directly.
				</p>
			)}
		</div>
	)
}
