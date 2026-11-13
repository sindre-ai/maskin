import { ViewerStage } from '@/components/files/viewer-stage'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { useFile } from '@/hooks/use-files'
import type { FileDetail } from '@/lib/api'
import { decodeBase64Utf8 } from '@/lib/file-utils'
import { readViewSources } from '@/lib/mini-app'
import { detectViewerVariantFromDom, detectViewerVariantFromFilename } from '@/lib/viewer-detect'
import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'

/**
 * Whether a pinned view is a deck or briefing page: a file marked as a briefing, or an HTML file
 * with slides that names no sources. A view with sources keeps the self-sizing frame, which is
 * the one that answers its queries.
 */
export function isDeckView(file: FileDetail): boolean {
	if (!file.mimeType.toLowerCase().startsWith('text/html') || file.contentOmitted) return false
	if (file.kind === 'briefing') return true
	const html = file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
	const variant = detectViewerVariantFromFilename(file.name) ?? detectViewerVariantFromDom(html)
	if (variant !== 'deck') return false
	const sources = readViewSources(html)
	return sources.ok && sources.sources.size === 0 && sources.lists.size === 0
}

/**
 * A briefing on the flow page: the same viewer the file page uses (a deck is fitted to the box
 * and paged), in a tall box instead of the auto-height frame custom views use, which shrinks a
 * deck to a strip. "Open full page" goes to the file page for annotations and comments.
 *
 * `hideTitle` is for a pinned view, whose tab already shows its name above the box.
 */
export function LoopBriefingStage({
	workspaceId,
	fileId,
	hideTitle = false,
}: {
	workspaceId: string
	fileId: string
	hideTitle?: boolean
}) {
	const { data: file, isLoading, isError } = useFile(workspaceId, fileId)
	if (isLoading) return <Skeleton className="h-[60vh] w-full" />
	if (isError || !file) {
		return (
			<p role="alert" className="text-sm text-muted-foreground">
				This briefing can't be shown right now.
			</p>
		)
	}
	return (
		<div className="min-w-0">
			<div className="mb-3 flex items-center gap-2.5 px-1">
				{hideTitle ? (
					<span className="flex-1" />
				) : (
					<h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
						{file.name.replace(/\.html?$/i, '')}
					</h2>
				)}
				<Link
					to="/$workspaceId/files/$fileId"
					params={{ workspaceId, fileId }}
					className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					Open full page <ExternalLink size={12} />
				</Link>
			</div>
			<div
				data-testid="loop-briefing-stage"
				className="relative flex h-[max(24rem,calc(100dvh-22rem))] min-h-0 overflow-hidden rounded-xl border border-border"
			>
				<ViewerStage file={file} />
			</div>
		</div>
	)
}
