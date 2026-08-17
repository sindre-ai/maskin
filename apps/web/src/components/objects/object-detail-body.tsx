import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { MarkdownContent } from '../shared/markdown-content'
import { formatValue } from './metadata-badges'
import { getDocumentFold, getEvidence } from './object-detail-fixtures'
import { ObjectEvidenceBlock } from './object-evidence-block'

export function ObjectDetailBody({ object }: { object: ObjectResponse }) {
	const fold = getDocumentFold(object)
	const evidence = getEvidence(object)
	const kvRows = kvEntries(object)

	return (
		<div className="space-y-8">
			{object.content ? (
				<MarkdownContent content={object.content} className="max-w-[75ch]" />
			) : null}

			{kvRows.length > 0 && (
				<dl className="divide-y divide-border rounded-md border border-border">
					{kvRows.map(([key, value]) => (
						<div key={key} className="flex items-baseline gap-3 px-3 py-2">
							<dt className="w-32 shrink-0 truncate text-xs text-muted-foreground">{key}</dt>
							<dd className="min-w-0 flex-1 break-words text-sm text-foreground">
								{formatValue(value)}
							</dd>
						</div>
					))}
				</dl>
			)}

			{fold && <DocumentFold fold={fold} />}

			{evidence && <ObjectEvidenceBlock evidence={evidence} />}
		</div>
	)
}

function DocumentFold({ fold }: { fold: { title: string; markdown: string } }) {
	const [open, setOpen] = useState(false)

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-foreground">
				<ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
				{fold.title}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-3">
					<MarkdownContent content={fold.markdown} />
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

// Public (non-underscore) metadata entries render as the body's key/value rows.
// `_`-prefixed keys are fixture/private keys (ask, evidence, fold) and stay out.
function kvEntries(object: ObjectResponse): [string, unknown][] {
	const metadata = object.metadata
	if (!metadata) return []
	return Object.entries(metadata).filter(([key]) => !key.startsWith('_'))
}
