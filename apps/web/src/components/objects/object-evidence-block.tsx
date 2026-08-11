import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

/**
 * Evidence for the object's claim — quote, source, date — behind its own
 * collapsible fold. The trigger is a Radix button so it is operable via mouse
 * and keyboard (Enter/Space).
 */
export function ObjectEvidenceBlock({
	quote,
	source,
	date,
	label = 'Evidence',
}: {
	quote: string
	source: string
	date: string | null
	label?: string
}) {
	const [open, setOpen] = useState(false)

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-border-hover hover:text-foreground">
				{label}
				<ChevronDown size={12} className={open ? '' : '-rotate-90'} aria-hidden />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<figure className="mt-3 max-w-[75ch] rounded-lg border border-border bg-bg-surface p-3">
					<blockquote className="text-sm italic leading-relaxed text-muted-foreground">
						“{quote}”
					</blockquote>
					<figcaption className="mt-1.5 text-xs text-muted-foreground">
						<span className="font-semibold text-primary">{source}</span>
						{date && (
							<>
								<span aria-hidden> · </span>
								{date}
							</>
						)}
					</figcaption>
				</figure>
			</CollapsibleContent>
		</Collapsible>
	)
}
