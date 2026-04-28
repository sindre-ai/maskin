import { DashboardHeadline } from '@/components/dashboard/dashboard-headline'
import { DecisionsPanel } from '@/components/dashboard/decisions-panel'
import { LiveFeedCaptions } from '@/components/dashboard/live-feed-captions'
import { NowHappeningHero } from '@/components/dashboard/now-happening-hero'
import { PipelineFlow } from '@/components/dashboard/pipeline-flow'
import { TeamRoster } from '@/components/dashboard/team-roster'
import { VitalsStrip } from '@/components/dashboard/vitals-strip'
import { RouteError } from '@/components/shared/route-error'
import { SindrePulseBar } from '@/components/sindre/sindre-pulse-bar'
import { useActors } from '@/hooks/use-actors'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/')({
	component: BridgeDashboard,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function BridgeDashboard() {
	const { workspaceId } = useWorkspace()
	const { data: actors } = useActors(workspaceId)

	const sindreActorId = useMemo(
		() => actors?.find((a) => a.type === 'agent' && a.name === 'Sindre')?.id ?? null,
		[actors],
	)

	return (
		<div className="space-y-8 pb-8">
			<DashboardHeadline />
			<SindrePulseBar workspaceId={workspaceId} sindreActorId={sindreActorId} />
			<NowHappeningHero />
			<DecisionsPanel />
			<TeamRoster />
			<PipelineFlow />
			<LiveFeedCaptions />
			<VitalsStrip workspaceId={workspaceId} />
		</div>
	)
}
