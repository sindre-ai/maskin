import type { EvidenceFixture } from './object-detail-fixtures'

export function ObjectEvidenceBlock({ evidence }: { evidence: EvidenceFixture }) {
	return (
		<div className="rounded-xl border border-border p-[11px_14px]">
			<blockquote className="italic text-[11.5px] text-muted-foreground">
				{evidence.quote}
			</blockquote>
			{(evidence.source || evidence.date) && (
				<p className="mt-2 text-[9.5px] text-muted-foreground/70">
					{evidence.source}
					{evidence.source && evidence.date && ' · '}
					{evidence.date}
				</p>
			)}
		</div>
	)
}
