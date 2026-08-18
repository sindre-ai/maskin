import { cn } from '@/lib/cn'
import { useState } from 'react'
import type { EvidenceFixture } from './object-detail-fixtures'

/** How many quote cards show before the dashed "+N more" fold (mockup 1128–1135). */
const EVIDENCE_VISIBLE_CAP = 2

export function ObjectEvidenceBlock({ evidence }: { evidence: EvidenceFixture[] }) {
	const [expanded, setExpanded] = useState(false)
	if (evidence.length === 0) return null

	const visible = expanded ? evidence : evidence.slice(0, EVIDENCE_VISIBLE_CAP)
	const hiddenCount = evidence.length - visible.length

	return (
		<div className="flex flex-wrap gap-2">
			{visible.map((item, index) => (
				<div
					// Quotes have no id of their own, so the key pairs the text with its
					// position — the list is derived from a fixed metadata order and
					// never reorders.
					key={`${item.quote}-${index}`}
					className="min-w-[200px] flex-1 rounded-xl border border-border px-3.5 py-3"
				>
					<blockquote className="text-[11.5px] italic leading-[1.45] text-foreground/80">
						“{item.quote}”
					</blockquote>
					{(item.source || item.date) && (
						<p className="mt-1.5 text-[9.5px] text-muted-foreground">
							{item.source && <span className="font-semibold">{item.source}</span>}
							{item.source && item.date && ' · '}
							{item.date}
						</p>
					)}
				</div>
			))}
			{(hiddenCount > 0 || expanded) && evidence.length > EVIDENCE_VISIBLE_CAP && (
				<button
					type="button"
					onClick={() => setExpanded((open) => !open)}
					className={cn(
						'flex shrink-0 items-center rounded-xl border border-dashed border-border px-3.5 py-3',
						'text-[11px] font-semibold text-muted-foreground transition-colors',
						'hover:border-border-strong hover:text-foreground',
					)}
				>
					{expanded ? 'Show less' : `+${hiddenCount} more`}
				</button>
			)}
		</div>
	)
}
