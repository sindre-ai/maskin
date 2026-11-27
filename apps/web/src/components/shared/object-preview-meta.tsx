import { cn } from '@/lib/cn'
import type { ObjectPreview } from '@maskin/shared'
import { Fragment, useLayoutEffect, useRef, useState } from 'react'

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
	// `address` rows break only at an address's own separators, never mid-word.
	const rows: Array<{ label: string; value: string; address?: boolean }> = []
	if (to.length > 0)
		rows.push({ label: 'To', value: to.map(formatRecipient).join(', '), address: true })
	if (cc.length > 0)
		rows.push({ label: 'Cc', value: cc.map(formatRecipient).join(', '), address: true })
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
				<ReplyContext
					key={preview.context}
					text={preview.context}
					label={to[0]?.name ? `${to[0].name} wrote` : 'In reply to'}
				/>
			) : null}
			{rows.length > 0 ? (
				<dl className="flex flex-col gap-0.5 text-[12.5px]">
					{rows.map((row) => (
						<div key={row.label} className="flex gap-2">
							<dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
							<dd className={cn('min-w-0 text-foreground', !row.address && 'break-words')}>
								{row.address ? breakableAddress(row.value) : row.value}
							</dd>
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

/**
 * The message a draft answers, clamped to five lines. A reply is approved after reading what it
 * answers, so a longer message opens in full with Show more; the toggle only appears when the
 * quote is actually cut off. The label names who wrote it (the draft goes back to them), or
 * says "In reply to" when no recipient is filed.
 */
function ReplyContext({ text, label }: { text: string; label: string }) {
	const quoteRef = useRef<HTMLQuoteElement>(null)
	const [expanded, setExpanded] = useState(false)
	const [clamped, setClamped] = useState(false)

	// Measured only while collapsed: once open, the toggle stays so it can be closed again.
	useLayoutEffect(() => {
		const quote = quoteRef.current
		if (quote && !expanded) setClamped(quote.scrollHeight > quote.clientHeight)
	}, [expanded])

	return (
		<figure className="mb-1">
			<figcaption className="text-[11px] text-muted-foreground">{label}</figcaption>
			<blockquote
				ref={quoteRef}
				className={`whitespace-pre-wrap border-l-2 border-border pl-2 text-[12.5px] text-muted-foreground ${expanded ? '' : 'line-clamp-5'}`}
			>
				{text}
			</blockquote>
			{clamped || expanded ? (
				<button
					type="button"
					aria-expanded={expanded}
					aria-label={
						expanded
							? 'Show less of the message this answers'
							: 'Show more of the message this answers'
					}
					onClick={() => setExpanded((open) => !open)}
					className="mt-0.5 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					{expanded ? 'Show less' : 'Show more'}
				</button>
			) : null}
		</figure>
	)
}

function formatRecipient(r: ObjectPreview['recipients'][number]): string {
	if (r.name && r.address) return `${r.name} <${r.address}>`
	return r.name ?? r.address ?? ''
}

/**
 * An address may break only where an address can: after the @, a dot or a hyphen.
 * Without this a long address either overflows the row or, with `break-words`,
 * splits mid-word and reads as two.
 */
function breakableAddress(value: string) {
	const parts = value.split(/(?<=[@.-])/)
	let offset = 0
	return parts.map((part) => {
		const key = offset
		offset += part.length
		return (
			<Fragment key={key}>
				{part}
				{key + part.length < value.length ? <wbr /> : null}
			</Fragment>
		)
	})
}
