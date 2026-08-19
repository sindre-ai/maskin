import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { MarkdownContent } from '../shared/markdown-content'
import { getDocumentFold, getEvidence } from './object-detail-fixtures'
import { ObjectEvidenceBlock } from './object-evidence-block'

/**
 * The document body: the lead paragraph, the doc blocks, the fold pill and the
 * evidence cards (mockup 1105–1136). Custom fields are deliberately not here —
 * the mockup keeps them in the properties drawer's CUSTOM FIELDS section
 * (1447–1455), so rendering them twice was drift.
 */
export function ObjectDetailBody({ object }: { object: ObjectResponse }) {
	const fold = getDocumentFold(object)
	const evidence = getEvidence(object)

	return (
		// The mockup runs the body at the document scale and holds it to a 75ch
		// measure (1105–1122); sections below it sit on the same column.
		<div className="mt-4 flex flex-col gap-3.5">
			{object.content ? (
				<MarkdownContent content={object.content} size="doc" className="max-w-[75ch]" />
			) : null}

			{fold && <DocumentFold fold={fold} />}

			{evidence.length > 0 && <ObjectEvidenceBlock evidence={evidence} />}
		</div>
	)
}

function DocumentFold({ fold }: { fold: { title: string; markdown: string } }) {
	const [open, setOpen] = useState(false)

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			{/* Rounded pill trigger, mockup 1124–1126. */}
			<CollapsibleTrigger className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground">
				{fold.title}
				<ChevronRight
					size={12}
					aria-hidden="true"
					className={cn('transition-transform', open && 'rotate-90')}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-3">
					<MarkdownContent content={fold.markdown} />
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
