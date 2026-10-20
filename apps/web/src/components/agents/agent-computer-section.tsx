import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDesktops } from '@/hooks/use-desktop'
import type { ActorResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { Maximize2, Minimize2, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'

// The popup zooms and slides in for 200ms (ui/dialog). noVNC fits the picture to
// its container when it connects, so connecting mid-animation fits a size that is
// still changing and the picture then re-fits in steps. Wait it out.
const DIALOG_SETTLE_MS = 260

/**
 * The agent's own computer, on its page. Every agent has one, created the first
 * time it is opened and put to sleep when idle (a sleeping one wakes in a few
 * seconds with everything exactly where it was).
 *
 * Opening this page must not by itself start or wake anything: a computer costs
 * memory while it runs. So it connects straight away only if it is already
 * running; otherwise it offers a button. "Expand" moves the live view into a
 * popup. Only one connection is ever open: while the popup is up, the inline
 * slot steps aside.
 *
 * The `workspace-desktop` flag is read once, by the parent (AgentDetailView).
 */
export function AgentComputerSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const queryClient = useQueryClient()
	const { data } = useDesktops(workspaceId)
	const [started, setStarted] = useState(false)
	const [expanded, setExpanded] = useState(false)
	const [settled, setSettled] = useState(false)

	useEffect(() => {
		if (!expanded) {
			setSettled(false)
			return
		}
		const timer = setTimeout(() => setSettled(true), DIALOG_SETTLE_MS)
		return () => clearTimeout(timer)
	}, [expanded])

	const status = data?.desktops.find((d) => d.agent_id === agent.id)?.status
	const live = started || status === 'running'
	const note = live ? 'Running' : status === 'suspended' ? 'Asleep' : 'Not started yet'

	const start = () => {
		setStarted(true)
		void queryClient.invalidateQueries({ queryKey: queryKeys.desktops.all(workspaceId) })
	}

	const expandButton = (
		<Button
			variant="ghost"
			size="sm"
			aria-label="Open computer in a popup"
			onClick={() => setExpanded(true)}
		>
			<Maximize2 size={15} />
			<span className="hidden sm:inline">Expand</span>
		</Button>
	)

	return (
		<section aria-label="Computer" className="flex flex-col gap-3">
			<AgentSectionHeading title="Computer" note={note} />

			{!live && (
				<div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-8 text-center">
					<Monitor size={20} className="text-muted-foreground" aria-hidden />
					<p className="max-w-sm text-sm text-muted-foreground">
						{status === 'suspended'
							? `${agent.name}'s computer is asleep. It wakes in a few seconds, exactly as it was left.`
							: `${agent.name} has its own computer. It is created the first time it is opened.`}
					</p>
					<Button variant="outline" size="sm" onClick={start}>
						{status === 'suspended' ? 'Wake up' : 'Start computer'}
					</Button>
				</div>
			)}

			{live && !expanded && (
				<DesktopViewer workspaceId={workspaceId} agentId={agent.id} toolbarEnd={expandButton} />
			)}

			{live && expanded && (
				<div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-8 text-center">
					<p className="text-sm text-muted-foreground">
						{agent.name}'s computer is open in a popup.
					</p>
					<Button variant="outline" size="sm" onClick={() => setExpanded(false)}>
						Bring it back here
					</Button>
				</div>
			)}

			<Dialog open={live && expanded} onOpenChange={setExpanded}>
				<DialogContent className="sm:max-w-5xl">
					<DialogTitle className="sr-only">{agent.name}'s computer</DialogTitle>
					<DialogDescription className="sr-only">
						Live view of {agent.name}'s computer. Use Take over to control it.
					</DialogDescription>
					{/* min-w-0: the dialog is a grid, and a grid item will not shrink below its
					    content (the 1280px noVNC canvas) unless told it may. */}
					<div className="min-w-0 pt-6">
						{settled ? (
							<DesktopViewer
								workspaceId={workspaceId}
								agentId={agent.id}
								toolbarEnd={
									<Button
										variant="ghost"
										size="sm"
										aria-label="Close popup"
										onClick={() => setExpanded(false)}
									>
										<Minimize2 size={15} />
										<span className="hidden sm:inline">Shrink</span>
									</Button>
								}
							/>
						) : (
							<div className="flex flex-col gap-2" aria-hidden>
								<div className="h-8" />
								<div className="aspect-video w-full rounded-lg border bg-muted" />
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</section>
	)
}
