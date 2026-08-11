import { MetadataBadgesView } from '@/components/objects/metadata-badges'
import {
	getEvidence,
	getFoldMarkdown,
	getFoldTitle,
} from '@/components/objects/object-detail-fixtures'
import { ObjectEvidenceBlock } from '@/components/objects/object-evidence-block'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ObjectResponse } from '@/lib/api'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

/**
 * Static body of the object-detail document: markdown prose (headings,
 * paragraphs, lists), key/value rows from non-`_` metadata, a collapsible
 * document fold, and an evidence block behind its own fold. Every element
 * comes from the shared component library — no page-local one-offs.
 */
export function ObjectDetailBody({ object }: { object: ObjectResponse }) {
	const foldMarkdown = getFoldMarkdown(object)
	const foldTitle = getFoldTitle(object)
	const evidence = getEvidence(object)
	const [foldOpen, setFoldOpen] = useState(false)

	return (
		<div className="space-y-5">
			<div className="space-y-4 max-w-[75ch]">
				{object.content ? <MarkdownContent content={object.content} size="sm" /> : null}
				<MetadataBadgesView object={object} />
			</div>

			{foldMarkdown && (
				<Collapsible open={foldOpen} onOpenChange={setFoldOpen} className="max-w-[75ch]">
					<CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-surface px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-border-hover hover:text-foreground">
						{foldTitle ?? 'Document'}
						<ChevronDown size={12} className={foldOpen ? '' : '-rotate-90'} aria-hidden />
					</CollapsibleTrigger>
					<CollapsibleContent>
						<MarkdownContent content={foldMarkdown} size="sm" className="mt-3" />
					</CollapsibleContent>
				</Collapsible>
			)}

			{evidence && (
				<ObjectEvidenceBlock quote={evidence.quote} source={evidence.source} date={evidence.date} />
			)}
		</div>
	)
}
