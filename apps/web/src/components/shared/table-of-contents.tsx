import { cn } from '@/lib/cn'
import { type RefObject, useEffect, useState } from 'react'

interface TocEntry {
	id: string
	text: string
	level: 2 | 3
}

/**
 * Renders a sticky list of anchor links to h2/h3 headings inside `targetRef`.
 *
 * Relies on rehype-slug having emitted an `id` on each heading during markdown
 * rendering (see `MarkdownContent`). Walks the DOM rather than re-parsing
 * markdown so it stays decoupled from the remark pipeline.
 *
 * Renders nothing when fewer than two headings exist — a TOC for a one-heading
 * article is noise.
 */
export function TableOfContents({
	targetRef,
	content,
	className,
}: {
	targetRef: RefObject<HTMLElement | null>
	/** Markdown source; changes trigger a re-scan of headings. */
	content: string
	className?: string
}) {
	const [entries, setEntries] = useState<TocEntry[]>([])

	useEffect(() => {
		const el = targetRef.current
		if (!el) return
		const headings = el.querySelectorAll<HTMLHeadingElement>('h2[id], h3[id]')
		const next: TocEntry[] = []
		headings.forEach((h) => {
			next.push({
				id: h.id,
				text: h.textContent?.trim() ?? '',
				level: h.tagName === 'H2' ? 2 : 3,
			})
		})
		setEntries(next)
	}, [targetRef, content])

	if (entries.length < 2) return null

	return (
		<nav
			aria-label="Table of contents"
			className={cn(
				'sticky top-6 text-xs text-muted-foreground border-l border-border pl-4',
				className,
			)}
		>
			<div className="font-medium text-foreground mb-2 uppercase tracking-wide text-[10px]">
				On this page
			</div>
			<ul className="space-y-1.5">
				{entries.map((e) => (
					<li key={e.id} className={e.level === 3 ? 'pl-3' : undefined}>
						<a
							href={`#${e.id}`}
							className="hover:text-primary transition-colors duration-150 block leading-snug"
						>
							{e.text}
						</a>
					</li>
				))}
			</ul>
		</nav>
	)
}
