import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/cn'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { EvidenceFixture } from './object-detail-fixtures'

export function ObjectEvidenceBlock({ evidence }: { evidence: EvidenceFixture }) {
	const [open, setOpen] = useState(false)

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-foreground">
				<ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
				Evidence
			</CollapsibleTrigger>
			<CollapsibleContent>
				<blockquote className="mt-3 border-l-2 border-border pl-3 text-sm text-foreground">
					{evidence.quote}
				</blockquote>
				{(evidence.source || evidence.date) && (
					<p className="mt-2 text-xs text-muted-foreground">
						{evidence.source}
						{evidence.source && evidence.date && ' · '}
						{evidence.date}
					</p>
				)}
			</CollapsibleContent>
		</Collapsible>
	)
}
