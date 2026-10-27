import { WorkspaceContext } from '@/lib/workspace-context'
import { canWriteWithRole } from '@/lib/workspace-role'
import { useContext } from 'react'

/**
 * Whether the signed-in person may change things in the current workspace.
 * False only for viewers. Reads the context directly, so a component rendered
 * outside a workspace (a dialog on the sign-in flow, a bare test) counts as
 * writable instead of throwing.
 */
export function useCanWrite(): boolean {
	const ctx = useContext(WorkspaceContext)
	return canWriteWithRole(ctx?.workspace.role)
}
