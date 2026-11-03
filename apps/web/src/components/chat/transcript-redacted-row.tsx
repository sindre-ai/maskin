/**
 * Where a message that held a secret used to sit: the transcript shows that it was
 * rewritten instead of silently changing it. Strikethrough on a muted row, italic
 * label, mono marker.
 */
export function TranscriptRedactedRow({ marker }: { marker: string }) {
	return (
		<div
			role="note"
			aria-label="Message redacted; credential vaulted"
			className="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
		>
			<span className="italic">Your message →</span>
			<code className="font-mono line-through decoration-muted-foreground/60">{marker}</code>
		</div>
	)
}
