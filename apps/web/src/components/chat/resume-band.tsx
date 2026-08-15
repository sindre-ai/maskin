import { RelativeTime } from '@/components/shared/relative-time'
import { RotateCcw } from 'lucide-react'

export interface ResumeItem {
	/** Short description of a recent turn or state, e.g. "You asked the Chief of Staff to look at retention". */
	text: string
}

/**
 * PICKING UP WHERE YOU LEFT OFF band. Shown above the transcript when the
 * caller has at least one item to summarise. Rendered as a violet-tinted card
 * — a compact recap so operators re-entering a mid-thread conversation know
 * where they are in one glance.
 */
export function ResumeBand({
	items,
	lastActivityAt,
}: {
	items: ResumeItem[]
	lastActivityAt: string | null
}) {
	if (items.length === 0) return null
	return (
		<section
			aria-label="Picking up where you left off"
			className="rounded-lg border border-primary-tint-border bg-primary-tint-2 p-3"
		>
			<header className="flex items-center gap-2">
				<span
					aria-hidden
					className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-primary-foreground"
				>
					<RotateCcw size={11} />
				</span>
				<h3 className="text-[10px] font-semibold uppercase tracking-[0.11em] text-primary">
					Picking up where you left off
				</h3>
				{lastActivityAt && (
					<span className="ml-auto text-[10px] text-muted-foreground">
						last spoke <RelativeTime date={lastActivityAt} />
					</span>
				)}
			</header>
			<ul className="mt-2 space-y-1 text-sm text-text-secondary">
				{items.map((item, i) => (
					<li key={`${i}-${item.text}`} className="flex gap-2">
						<span aria-hidden className="text-primary/60">
							→
						</span>
						<span className="min-w-0 flex-1 leading-snug">{item.text}</span>
					</li>
				))}
			</ul>
		</section>
	)
}
