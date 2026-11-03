import { createContext, useContext } from 'react'
import type { WorkspaceWithRole } from './api'
import type { SSEStatus } from './sse'

export interface WorkspaceContextValue {
	workspace: WorkspaceWithRole
	workspaceId: string
	sseStatus: SSEStatus
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
	const ctx = useContext(WorkspaceContext)
	if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceContext provider')
	return ctx
}

/** Whether the current workspace is enterprise; false outside a workspace, for views that render without one. */
export function useIsEnterpriseWorkspace(): boolean {
	return useContext(WorkspaceContext)?.workspace.enterprise ?? false
}
