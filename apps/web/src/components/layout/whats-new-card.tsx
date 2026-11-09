import { useWhatsNew } from '@/hooks/use-whats-new'
import { formatWhatsNewDate } from '@/lib/whats-new'
import { X } from 'lucide-react'

/** Left-nav card announcing the newest change; dismissed per entry, remembered in this browser. */
export function WhatsNewCard() {
	const { entry, dismiss } = useWhatsNew()
	if (!entry) return null

	return (
		<section
			aria-label="What's new"
			className="mb-3 flex flex-col gap-1.5 rounded-xl bg-background py-3 pr-3 pl-3.5 shadow-sm ring-1 ring-border group-data-[collapsible=icon]:hidden"
		>
			<div className="flex items-center gap-2">
				<span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					What's new
				</span>
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss"
					title="Dismiss"
					className="grid size-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent max-md:size-11"
				>
					<X aria-hidden="true" className="size-2.5" />
				</button>
			</div>
			<p className="text-[13px] font-semibold leading-snug text-foreground">{entry.title}</p>
			<p className="text-xs leading-snug text-muted-foreground">{entry.body}</p>
			<p className="text-[11.5px] text-muted-foreground">{formatWhatsNewDate(entry.date)}</p>
		</section>
	)
}
