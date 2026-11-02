/**
 * The full Transcript view a call's summary card opens: one row per spoken
 * line, with its time in the call, who said it, and the text. A right-hand
 * drawer from 700px up, a full-screen page below.
 */

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { formatCallClock } from '@/lib/voice-receipts'
import type { VoiceTranscriptEntry } from '@/lib/voice-transcript'
import type { RefObject } from 'react'

export function VoiceTranscriptView({
	open,
	onOpenChange,
	lines,
	durationSeconds,
	returnFocusTo,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	lines: VoiceTranscriptEntry[]
	durationSeconds?: number
	/** What opened the view: it gets focus back when the view closes. */
	returnFocusTo?: RefObject<HTMLElement | null>
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				// Full screen below 700px (the sheet's own sm:max-w-sm would cap it at
				// 384px from 640), a drawer from there up.
				className="flex w-full flex-col gap-0 p-0 sm:max-w-none min-[43.75rem]:max-w-md"
				aria-label="Transcript"
				onCloseAutoFocus={(e) => {
					if (!returnFocusTo?.current) return
					e.preventDefault()
					returnFocusTo.current.focus()
				}}
			>
				<header className="flex flex-col gap-1 px-5 pb-4 pt-6 pr-16">
					<SheetTitle className="text-3xl font-extrabold tracking-tight">Transcript</SheetTitle>
					<SheetDescription className="text-sm text-muted-foreground">
						Live meeting{durationSeconds ? ` · ${formatCallClock(durationSeconds)}` : ''}
					</SheetDescription>
				</header>
				{lines.length === 0 ? (
					<p className="px-5 py-6 text-sm text-muted-foreground">
						No spoken lines were saved for this call.
					</p>
				) : (
					<ol className="mx-5 flex flex-1 flex-col overflow-y-auto border-t border-border">
						{lines.map((line) => (
							<li
								key={line.id}
								className="flex items-start justify-between gap-4 border-b border-border py-3"
							>
								<div className="min-w-0">
									<p className="text-base font-semibold text-foreground">{line.speaker}</p>
									<p className="text-sm text-muted-foreground">{line.text}</p>
								</div>
								<span className="shrink-0 pt-0.5 font-mono text-sm text-muted-foreground">
									{formatCallClock(line.t)}
								</span>
							</li>
						))}
					</ol>
				)}
			</SheetContent>
		</Sheet>
	)
}
