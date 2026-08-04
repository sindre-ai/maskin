import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { useTodayBrief } from '@/lib/today-brief-context'
import { X } from 'lucide-react'

// Renders inline as a right-rail at ≥1024 (feed stays visible beside it) and
// as a right-side Sheet overlay below. The T2 header trigger drives open state
// via `useTodayBrief()`; T4 has no dependency on T2 landing first.
export function TodayBriefPanel() {
	const { open, setOpen } = useTodayBrief()
	const isDesktop = useIsDesktopViewport()

	if (isDesktop) {
		if (!open) return null
		return (
			<aside
				aria-label="Today's brief"
				data-testid="todays-brief-panel"
				data-mode="rail"
				className={cn(
					'flex w-[340px] flex-shrink-0 flex-col gap-4 overflow-y-auto',
					'border-l border-border bg-sidebar p-4',
				)}
			>
				<div className="flex items-center justify-between">
					<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						Today's brief
					</h2>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={() => setOpen(false)}
						aria-label="Close today's brief"
					>
						<X className="h-4 w-4" />
					</Button>
				</div>
				<BriefBody />
			</aside>
		)
	}

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent
				side="right"
				data-testid="todays-brief-panel"
				data-mode="sheet"
				className="flex w-full flex-col gap-4 overflow-y-auto bg-sidebar p-4 sm:max-w-sm"
			>
				<SheetTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Today's brief
				</SheetTitle>
				<SheetDescription className="sr-only">
					Audio brief and mentioned items for today.
				</SheetDescription>
				<BriefBody />
			</SheetContent>
		</Sheet>
	)
}

function BriefBody() {
	return (
		<div className="flex flex-col gap-4">
			<BriefAudioPlaceholder />
			<div>
				<h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Mentioned
				</h3>
				<MentionedPlaceholder />
			</div>
		</div>
	)
}

function BriefAudioPlaceholder() {
	return (
		<div
			className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground"
			role="note"
		>
			Today's brief will appear here once the briefing pipeline lands.
		</div>
	)
}

function MentionedPlaceholder() {
	return (
		<div
			className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground"
			role="note"
		>
			Mentioned items will appear here once the briefing pipeline lands.
		</div>
	)
}
