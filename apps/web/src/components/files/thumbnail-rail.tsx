import { cn } from '@/lib/cn'

interface ThumbnailRailProps {
	total: number
	activeIndex: number
	onSelect: (index: number) => void
}

// Vertical rail listing every page of a paged doc. Each tile is a 16:9
// numbered card that drives the same showPage(i) path as keyboard nav —
// the parent wires onSelect to gotoPage, which posts VIEWER_GOTO_PAGE_MESSAGE
// into the iframe (see viewer-stage.tsx). No per-slide preview render: the
// sandboxed frame has null origin, so we can't paint a cross-window snapshot.
// The tile shows the page number and is the same shape the parent doc will
// take at fit, so users can still count pages and see which one is active.
export function ThumbnailRail({ total, activeIndex, onSelect }: ThumbnailRailProps) {
	return (
		<div
			className="flex h-full w-[132px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-card p-2"
			aria-label="Page thumbnails"
			role="tablist"
			aria-orientation="vertical"
		>
			{Array.from({ length: total }, (_, i) => {
				const isActive = i === activeIndex
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: the index IS the page identity — pages don't reorder and there is no other stable key
						key={i}
						type="button"
						role="tab"
						aria-selected={isActive}
						aria-label={`Go to page ${i + 1} of ${total}`}
						onClick={() => onSelect(i)}
						className={cn(
							'group flex aspect-video w-full flex-col items-center justify-center rounded-md border bg-background text-xs font-medium text-muted-foreground transition-colors',
							'hover:border-border-strong hover:text-foreground',
							'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							isActive ? 'border-brand text-foreground ring-1 ring-brand' : 'border-border',
						)}
					>
						{i + 1}
					</button>
				)
			})}
		</div>
	)
}
