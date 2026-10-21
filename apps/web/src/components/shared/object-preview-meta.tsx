import type { ObjectPreview } from '@maskin/shared'

interface ObjectPreviewMetaProps {
	preview: ObjectPreview
}

/**
 * Who the text goes to, its subject, where it is published, and anything to fix before it can go: the part of
 * an object's preview that is not the text itself. The same block sits above the body in
 * chat, in For You and in the object page, so a draft reads the same wherever it is met.
 * Recipients show their name first and the address beside it, never one without the other
 * when both are known.
 */
export function ObjectPreviewMeta({ preview }: ObjectPreviewMetaProps) {
	const to = preview.recipients.filter((r) => r.role === 'to')
	const cc = preview.recipients.filter((r) => r.role === 'cc')
	const rows: Array<{ label: string; value: string }> = []
	if (to.length > 0) rows.push({ label: 'To', value: to.map(formatRecipient).join(', ') })
	if (cc.length > 0) rows.push({ label: 'Cc', value: cc.map(formatRecipient).join(', ') })
	if (preview.subject) rows.push({ label: 'Subject', value: preview.subject })
	// Where else it goes or when: the account a post is published as, a Slack channel.
	for (const detail of preview.details ?? []) rows.push(detail)
	const problems = [
		...(preview.missing.length > 0 ? [`Missing: ${preview.missing.join(', ')}`] : []),
		...preview.warnings,
	]
	if (rows.length === 0 && problems.length === 0 && !preview.context) return null

	return (
		<div className="flex flex-col gap-1">
			{/* What the draft answers, so the text below is read in context. Not sent. */}
			{preview.context ? (
				<figure className="mb-1">
					<figcaption className="text-[11px] text-muted-foreground">In reply to</figcaption>
					<blockquote className="line-clamp-5 whitespace-pre-wrap border-l-2 border-border pl-2 text-[12.5px] text-muted-foreground">
						{preview.context}
					</blockquote>
				</figure>
			) : null}
			{rows.length > 0 ? (
				<dl className="flex flex-col gap-0.5 text-[12.5px]">
					{rows.map((row) => (
						<div key={row.label} className="flex gap-2">
							<dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
							<dd className="min-w-0 break-words text-foreground">{row.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			{problems.map((problem) => (
				<p key={problem} role="alert" className="text-[12.5px] text-warning">
					{problem}
				</p>
			))}
		</div>
	)
}

function formatRecipient(r: ObjectPreview['recipients'][number]): string {
	if (r.name && r.address) return `${r.name} <${r.address}>`
	return r.name ?? r.address ?? ''
}
