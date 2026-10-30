// Where a search result goes when it is opened. The page and the launcher share it,
// so a row leads to the same place from both.

import type { SearchResultRow } from '@maskin/shared'
import type { useNavigate } from '@tanstack/react-router'

type Navigate = ReturnType<typeof useNavigate>

export function navigateToSearchRow(
	navigate: Navigate,
	workspaceId: string,
	row: Pick<SearchResultRow, 'group' | 'id'>,
): void {
	switch (row.group) {
		case 'chats':
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: row.id },
			})
			return
		case 'loops':
			navigate({ to: '/$workspaceId/loops/$loopId', params: { workspaceId, loopId: row.id } })
			return
		case 'agents':
			navigate({ to: '/$workspaceId/agents/$agentId', params: { workspaceId, agentId: row.id } })
			return
		case 'people':
			// The members page opens the person's dialog from ?member=.
			navigate({
				to: '/$workspaceId/settings/members',
				params: { workspaceId },
				search: { member: row.id },
			})
			return
		case 'automations':
			navigate({
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: row.id },
			})
			return
		case 'objects':
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId: row.id },
			})
			return
	}
}
