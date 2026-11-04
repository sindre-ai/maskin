import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Minimize2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

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
	actions,
}: {
	workspaceId: string
	agentId: string
	agentName: string
	onOpenAgent?: (agentId: string) => void
	/** Buttons shown under the view, inline and in the popup (the chat's Done). */
	actions?: ReactNode
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

	// The popup's top row, next to the dialog's own close button: the chat's Done, then minimize.
	const popupEnd = (
		<>
			{/* Same height as the rest of the row, so the popup's top bar stays one slim line. */}
			{actions ? <div className="[&_button]:h-7">{actions}</div> : null}
			<Button
				variant="ghost"
				size="icon"
				className="size-7"
				aria-label="Close popup"
				onClick={() => setExpanded(false)}
			>
				<Minimize2 size={15} />
			</Button>
		</>
	)

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
					{actions ? <div className="flex justify-center">{actions}</div> : null}
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
				{/* As wide as the screen allows while the 16:9 picture plus the top row still fit
				    the height, so the picture never needs to scroll. The 5.5rem is the top row, the
				    padding and a little air above and below the popup. On a phone the popup is pinned
				    to the top and runs edge to edge. */}
				<DialogContent className="gap-2 p-3 pt-2.5 max-sm:top-0 max-sm:w-full max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0 max-sm:px-0 sm:max-w-[min(96vw,calc((100dvh_-_5.5rem)*16/9))]">
					<DialogTitle className="sr-only">{agentName}'s computer</DialogTitle>
					<DialogDescription className="sr-only">
						Live view of {agentName}'s computer. Use Take control to control it.
					</DialogDescription>
					{/* min-w-0: the dialog is a grid, and a grid item will not shrink below its
					    content (the 1600px noVNC canvas) unless told it may. */}
					<div className="min-w-0">
						{settled ? (
							<DesktopViewer
								workspaceId={workspaceId}
								agentId={agentId}
								onOpenAgent={onOpenAgent}
								variant="immersive"
								toolbarEnd={popupEnd}
							/>
						) : (
							<div className="flex min-w-0 flex-col gap-2">
								<div className="flex h-7 items-center justify-end gap-2 pr-5">{popupEnd}</div>
								<div
									className="aspect-video w-full rounded-lg border bg-muted max-sm:rounded-none max-sm:border-0"
									aria-hidden
								/>
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}
