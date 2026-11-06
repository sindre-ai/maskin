import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import type { FileDetail } from '@/lib/api'
import { decodeBase64Utf8, formatSize } from '@/lib/file-utils'
import type { AttachingObject } from '@/lib/viewer-provenance'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'

/** The text of a file, one entry per paragraph, with block markers stripped. */
export function readableLines(file: FileDetail): string[] {
	const text = file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
	const lines: string[] = []
	let inFence = false
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (line.startsWith('```')) {
			inFence = !inFence
			continue
		}
		if (inFence || line === '' || /^[-*_]{3,}$/.test(line)) continue
		lines.push(line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, ''))
	}
	return lines
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <h2 className="text-xs font-semibold text-muted-foreground">{children}</h2>
}

/**
 * The text-first view of a document: title, what it is and who made it, where
 * it is attached, then its lines. Tapping a line opens the document to comment
 * on it. The full editor and review panel stay one tap away ("Edit and review").
 */
export function FileReadView({
	file,
	workspaceId,
	authorName,
	attachers,
	onOpenEditor,
	onAsk,
}: {
	file: FileDetail
	workspaceId: string
	authorName: string | null
	attachers: AttachingObject[]
	onOpenEditor: () => void
	onAsk: () => void
}) {
	const lines = useMemo(() => readableLines(file), [file])
	const meta = ['Markdown', formatSize(file.sizeBytes), authorName].filter((p): p is string =>
		Boolean(p),
	)
	return (
		<div className="h-full w-full overflow-auto" data-testid="file-read-view">
			<div className="mx-auto flex max-w-[740px] flex-col gap-6 px-5 py-8 md:px-6">
				<header className="flex flex-col gap-2">
					<h1 className="break-words text-4xl font-extrabold leading-tight tracking-tight">
						{file.name}
					</h1>
					<p className="text-sm text-muted-foreground">
						{meta.map((part) => (
							<span key={part}>{part} · </span>
						))}
						<RelativeTime date={file.createdAt} />
					</p>
				</header>

				{attachers.length > 0 && (
					<section className="flex flex-col gap-2">
						<SectionLabel>Attached to</SectionLabel>
						<ul className="flex flex-col border-t border-border">
							{attachers.map((a) => (
								<li key={a.id} className="border-b border-border">
									<Link
										to="/$workspaceId/objects/$objectId"
										params={{ workspaceId, objectId: a.id }}
										className="flex items-center justify-between gap-3 py-3 hover:bg-muted/50"
									>
										<span className="min-w-0">
											<span className="block truncate text-base font-semibold">{a.title}</span>
											<span className="block truncate text-xs text-muted-foreground">
												{a.attacherName} · <RelativeTime date={a.attachedAt} />
											</span>
										</span>
										<span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
											{a.driverType === 'agent' ? 'Agent driver' : null}
											<ChevronRight size={16} aria-hidden="true" />
										</span>
									</Link>
								</li>
							))}
						</ul>
					</section>
				)}

				<section className="flex flex-col gap-2">
					<SectionLabel>Tap a line to pin a comment</SectionLabel>
					{lines.length === 0 ? (
						<p className="border-t border-border py-3 text-sm text-muted-foreground">
							This file has no text yet.
						</p>
					) : (
						<ul className="flex flex-col border-t border-border">
							{lines.map((line, i) => (
								// Lines can repeat, so the position is part of the identity.
								<li key={`${i}-${line}`} className="border-b border-border">
									<button
										type="button"
										onClick={onOpenEditor}
										className="block w-full py-3 text-left text-base font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										{line}
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" className="h-11 rounded-full px-6 text-base" onClick={onAsk}>
						Ask about this file
					</Button>
					<Button type="button" variant="ghost" className="rounded-full" onClick={onOpenEditor}>
						Edit and review
					</Button>
				</div>
			</div>
		</div>
	)
}
