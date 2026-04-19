import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link, useParams } from '@tanstack/react-router'
import { useMemo } from 'react'

interface WikiLayoutProps {
	workspaceId: string
	articles: ObjectResponse[]
	children: React.ReactNode
}

/**
 * Two-pane layout used by every wiki route: tag-grouped article list on the
 * left, arbitrary content on the right. Deliberately does not use the shadcn
 * `<Sidebar>` primitive — that's the app-shell sidebar, we don't want two of
 * them on screen at once.
 */
export function WikiLayout({ workspaceId, articles, children }: WikiLayoutProps) {
	const grouped = useMemo(() => groupByTag(articles), [articles])
	const params = useParams({ strict: false }) as { articleId?: string }
	const activeId = params.articleId

	return (
		<div className="flex min-h-[calc(100vh-3rem)]">
			<aside className="hidden md:flex md:flex-col w-64 shrink-0 border-r border-border bg-bg-surface">
				<div className="px-4 py-3 border-b border-border">
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Wiki
					</div>
					<div className="text-xs text-muted-foreground mt-0.5">
						{articles.length} {articles.length === 1 ? 'article' : 'articles'}
					</div>
				</div>
				<div className="flex-1 overflow-y-auto py-2">
					{grouped.length === 0 ? (
						<div className="px-4 py-3 text-xs text-muted-foreground">No articles yet.</div>
					) : (
						grouped.map((group) => (
							<div key={group.tag} className="mb-3">
								<div className="px-4 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									{group.tag}
								</div>
								<ul>
									{group.articles.map((article) => (
										<li key={article.id}>
											<Link
												to="/$workspaceId/wiki/$articleId"
												params={{ workspaceId, articleId: article.id }}
												className={cn(
													'block px-4 py-1.5 text-xs truncate hover:bg-bg-hover transition-colors duration-150',
													activeId === article.id
														? 'bg-bg-hover text-foreground font-medium'
														: 'text-muted-foreground',
												)}
											>
												{article.title || 'Untitled'}
											</Link>
										</li>
									))}
								</ul>
							</div>
						))
					)}
				</div>
			</aside>
			<div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
		</div>
	)
}

interface TagGroup {
	tag: string
	articles: ObjectResponse[]
}

function groupByTag(articles: ObjectResponse[]): TagGroup[] {
	const byTag = new Map<string, ObjectResponse[]>()
	for (const article of articles) {
		const tagsRaw =
			typeof article.metadata === 'object' &&
			article.metadata !== null &&
			'tags' in article.metadata
				? (article.metadata as { tags?: unknown }).tags
				: undefined
		const tags = parseTags(tagsRaw)
		if (tags.length === 0) {
			upsert(byTag, 'Untagged', article)
		} else {
			for (const tag of tags) upsert(byTag, tag, article)
		}
	}
	// Sort tags alphabetically with Untagged last, sort articles by title.
	return Array.from(byTag.entries())
		.sort(([a], [b]) => {
			if (a === 'Untagged') return 1
			if (b === 'Untagged') return -1
			return a.localeCompare(b)
		})
		.map(([tag, list]) => ({
			tag,
			articles: list
				.slice()
				.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '')),
		}))
}

function upsert(map: Map<string, ObjectResponse[]>, key: string, value: ObjectResponse) {
	const existing = map.get(key)
	if (existing) {
		if (!existing.includes(value)) existing.push(value)
	} else {
		map.set(key, [value])
	}
}

function parseTags(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String).map((t) => t.trim()).filter(Boolean)
	if (typeof raw === 'string') {
		return raw
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
	}
	return []
}
