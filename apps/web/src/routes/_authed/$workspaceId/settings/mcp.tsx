import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { RouteError } from '@/components/shared/route-error'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/mcp')({
	component: McpPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function McpPage() {
	const { workspaceId } = useWorkspace()

	return (
		<div className="max-w-lg">
			<McpConnectionSection workspaceId={workspaceId} />
		</div>
	)
}
