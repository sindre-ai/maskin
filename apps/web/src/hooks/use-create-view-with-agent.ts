import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import {
	CREATE_VIEW_AGENT_NAME,
	type CreateViewScope,
	createViewChatLink,
} from '@/lib/create-view-message'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

/**
 * The "Create view with agent" menu item. `open` is null when the item should not
 * show: flag off, a viewer, or no Design Studio in this workspace.
 */
export function useCreateViewWithAgent(): { open: ((scope: CreateViewScope) => void) | null } {
	const enabled = useFeatureFlag('create-view-with-agent')
	const canWrite = useCanWrite()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { data: actors } = useActors(workspaceId, { enabled })
	const agent = useMemo(() => {
		const found = actors?.find((a) => a.type === 'agent' && a.name === CREATE_VIEW_AGENT_NAME)
		return found ? { id: found.id, name: found.name } : null
	}, [actors])

	const open = useCallback(
		(scope: CreateViewScope) => {
			if (!agent) return
			navigate(createViewChatLink(workspaceId, agent, scope))
		},
		[agent, navigate, workspaceId],
	)

	return { open: enabled && canWrite && agent ? open : null }
}
