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
				className="flex w-full flex-col gap-0 p-0 sm:max-w-none min-[700px]:max-w-md"
				aria-label="Transcript"
				onCloseAutoFocus={(e) => {
					if (!returnFocusTo?.current) return
					e.preventDefault()
					returnFocusTo.current.focus()
				}}
			>
				<header className="flex flex-col gap-1 border-b border-border px-5 py-4 pr-16">
					<SheetTitle className="text-lg font-bold tracking-tight">Transcript</SheetTitle>
					<SheetDescription className="font-mono text-[13px] font-semibold">
						{durationSeconds ? `${formatCallClock(durationSeconds)} · ` : ''}
						{lines.length} {lines.length === 1 ? 'line' : 'lines'}
					</SheetDescription>
				</header>
				{lines.length === 0 ? (
					<p className="px-5 py-6 text-sm text-muted-foreground">
						No spoken lines were saved for this call.
					</p>
				) : (
					<ol className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
						{lines.map((line) => (
							<li key={line.id} className="grid grid-cols-[3.5rem_1fr] gap-x-3">
								<span className="pt-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
									{formatCallClock(line.t)}
								</span>
								<div className="min-w-0">
									<p className="text-[13px] font-semibold text-foreground">{line.speaker}</p>
									<p className="text-sm text-foreground">{line.text}</p>
								</div>
							</li>
						))}
					</ol>
				)}
			</SheetContent>
		</Sheet>
	)
}
