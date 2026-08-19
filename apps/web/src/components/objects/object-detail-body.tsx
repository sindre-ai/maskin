import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { MarkdownContent } from '../shared/markdown-content'
import { CommitmentCard } from './commitment-card'
import { getDocumentFold, getEvidence } from './object-detail-fixtures'
import { ObjectEvidenceBlock } from './object-evidence-block'

/**
 * The document body: the lead paragraph, the doc blocks, the fold pill and the
 * evidence cards (mockup 1105–1136). Custom fields are deliberately not here —
 * the mockup keeps them in the properties drawer's CUSTOM FIELDS section
 * (1447–1455), so rendering them twice was drift.
 */
export function ObjectDetailBody({
	object,
	workspaceId,
	onContentChange,
}: {
	object: ObjectResponse
	workspaceId: string
	/** Wire this to make the document body editable in place, the way the
	 *  pre-v2 surface did. Omitted by read-only hosts (the MCP-app embed). */
	onContentChange?: (content: string) => void
}) {
	const fold = getDocumentFold(object)
	const evidence = getEvidence(object)

	return (
		// The mockup runs the body at the document scale and holds it to a 75ch
		// measure (1105–1122); sections below it sit on the same column.
		<div className="mt-4 flex flex-col gap-3.5">
			{/* Commitments lead with their card (floor, cadence, source bet, last
			    breach) — the generic rows can't carry the source-bet link or the
			    status chip. Carried over from the retired document. */}
			{object.type === 'commitment' && <CommitmentCard object={object} workspaceId={workspaceId} />}

			{/* Editable when the host wires a commit handler — an empty body still
			    renders the editor so a new object can be written into, which a
			    truthy-content guard alone would make impossible. */}
			{object.content || onContentChange ? (
				<MarkdownContent
					content={object.content ?? ''}
					size="doc"
					className="max-w-[75ch]"
					editable={Boolean(onContentChange)}
					onChange={onContentChange}
				/>
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
