import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Minimize2 } from 'lucide-react'
import { useEffect, useState } from 'react'

// The popup zooms and slides in for 200ms (ui/dialog). noVNC fits the picture to
// its container when it connects, so connecting mid-animation fits a size that is
// still changing and the picture then re-fits in steps. Wait it out.
const DIALOG_SETTLE_MS = 260

/**
 * A live view of one agent's computer that can be expanded into a popup. Shared by
 * the agent page and the "act on my computer" card in chat, so both behave alike.
 *
 * Only one connection is ever open: while the popup is up, the inline slot steps
 * aside. The caller decides WHEN to show it (it connects as soon as it mounts), so a
 * page can keep from waking a computer just because it was opened.
 */
export function ExpandableDesktop({
	workspaceId,
	agentId,
	agentName,
	onOpenAgent,
}: {
	workspaceId: string
	agentId: string
	agentName: string
	onOpenAgent?: (agentId: string) => void
}) {
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

	return (
		<>
			{!expanded && (
				<div className="flex min-w-0 flex-col gap-2">
					{/* The picture is a preview only: the whole card is one button that opens
					    the popup, where the controls live. */}
					<div className="min-w-0 overflow-hidden rounded-2xl">
						<DesktopViewer
							workspaceId={workspaceId}
							agentId={agentId}
							variant="preview"
							onOpen={() => setExpanded(true)}
							onOpenAgent={onOpenAgent}
						/>
					</div>
					<p className="text-center text-sm text-muted-foreground">{agentName}'s screen</p>
				</div>
			)}

			{expanded && (
				<div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-8 text-center">
					<p className="text-sm text-muted-foreground">
						{agentName}'s computer is open in a popup.
					</p>
					<Button variant="outline" size="sm" onClick={() => setExpanded(false)}>
						Bring it back here
					</Button>
				</div>
			)}

			<Dialog open={expanded} onOpenChange={setExpanded}>
				{/* As wide as the screen allows while the 16:9 picture plus the pill under it
				    still fit the height, so the picture never needs to scroll. */}
				<DialogContent className="sm:max-w-[min(96vw,calc((100dvh_-_9rem)*16/9))]">
					<DialogTitle className="sr-only">{agentName}'s computer</DialogTitle>
					<DialogDescription className="sr-only">
						Live view of {agentName}'s computer. Use Take control to control it.
					</DialogDescription>
					<Button
						variant="ghost"
						size="icon"
						className="absolute right-10 top-3 size-7"
						aria-label="Close popup"
						onClick={() => setExpanded(false)}
					>
						<Minimize2 size={15} />
					</Button>
					{/* min-w-0: the dialog is a grid, and a grid item will not shrink below its
					    content (the 1280px noVNC canvas) unless told it may. */}
					<div className="min-w-0 pt-6">
						{settled ? (
							<DesktopViewer
								workspaceId={workspaceId}
								agentId={agentId}
								onOpenAgent={onOpenAgent}
								variant="immersive"
							/>
						) : (
							<div className="aspect-video w-full rounded-lg border bg-muted" aria-hidden />
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}
