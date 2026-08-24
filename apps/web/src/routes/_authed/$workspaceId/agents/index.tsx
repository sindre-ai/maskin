import { AgentsIndexView } from '@/components/agents/agents-index-view'
import { LegacyAgentsIndexPage } from '@/components/agents/legacy/agents-index-page'
import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useNewDesign } from '@/lib/new-design-context'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * The `new-design` boundary for the Agents index. The flag is read once, at the
 * workspace shell, and only the resolved boolean reaches here via
 * `useNewDesign()` — a route page can't be swapped at the boundary itself.
 */
function AgentsRoute() {
	return useNewDesign() ? <AgentsPageV2 /> : <LegacyAgentsIndexPage />
}

function AgentsPageV2() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId, { paged: true })
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	// The nav row draws the title and this muted count — PageHeader renders
	// nothing inline (mockup's `agentsHeadSub`).
	const subtitle = agents.length
		? `${agents.length} agent${agents.length === 1 ? '' : 's'} · each owns one outcome`
		: undefined

	if (isLoading) {
		return (
			<div>
				<PageHeader title="Agents" />
				<ListSkeleton />
				<CreatePicker
					open={createPickerOpen}
					onOpenChange={setCreatePickerOpen}
					defaultType="agent"
				/>
			</div>
		)
	}

	return (
		<div>
			<PageHeader title="Agents" subtitle={subtitle} />
			{agents.length === 0 ? (
				<EmptyState
					emphasis="page"
					icon={<Users size={28} aria-hidden />}
					title="Nobody on this team yet."
					description="Agents own one outcome each and run on their own. Add the first one to get started."
					action={<Button onClick={() => setCreatePickerOpen(true)}>Create an agent</Button>}
				/>
			) : (
				<AgentsIndexView workspaceId={workspaceId} agents={agents} sessions={sessions ?? []} />
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="agent"
			/>
		</div>
	)
}
