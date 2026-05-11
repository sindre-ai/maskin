import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { usePinnedPages } from '@/hooks/use-pinned-pages'
import { ALL_PAGES, CATEGORY_LABELS, type PageDefinition } from '@/lib/pinned-pages'
import { createFileRoute } from '@tanstack/react-router'
import { Pin, PinOff, Search } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/pages')({
	component: AllPagesPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AllPagesPage() {
	const [query, setQuery] = useState('')
	const { allPages, isPinned, pin, unpin } = usePinnedPages()

	const filtered = query
		? allPages.filter(
				(p) =>
					p.label.toLowerCase().includes(query.toLowerCase()) ||
					p.description.toLowerCase().includes(query.toLowerCase()),
			)
		: allPages

	// Group by category, preserving display order
	const categories = (
		['workspace', 'library', 'settings'] satisfies PageDefinition['category'][]
	).filter((cat) => filtered.some((p) => p.category === cat))

	const pinnedCount = allPages.filter((p) => isPinned(p.id)).length

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="shrink-0 px-6 pt-6 pb-4 border-b border-border">
				<div className="flex items-baseline justify-between gap-4 mb-4">
					<div>
						<h1 className="text-xl font-semibold tracking-tight">All pages</h1>
						<p className="text-sm text-muted-foreground mt-0.5">
							Pin the ones you want in the left nav. Drag in the sidebar to reorder.
						</p>
					</div>
					<span className="text-xs text-muted-foreground shrink-0">
						{pinnedCount} of {ALL_PAGES.length} pinned
					</span>
				</div>
				<div className="relative max-w-sm">
					<Search
						size={13}
						className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search pages…"
						className="pl-8"
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
				{categories.length === 0 && (
					<p className="text-sm text-muted-foreground py-8 text-center">
						No pages match your search.
					</p>
				)}
				{categories.map((cat) => {
					const pages = filtered.filter((p) => p.category === cat)
					return (
						<section key={cat}>
							<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
								{CATEGORY_LABELS[cat]}
							</h2>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
								{pages.map((page) => (
									<PageCard
										key={page.id}
										page={page}
										pinned={isPinned(page.id)}
										onToggle={() => (isPinned(page.id) ? unpin(page.id) : pin(page.id))}
									/>
								))}
							</div>
						</section>
					)
				})}
			</div>
		</div>
	)
}

interface PageCardProps {
	page: PageDefinition
	pinned: boolean
	onToggle: () => void
}

function PageCard({ page, pinned, onToggle }: PageCardProps) {
	const Icon = page.icon
	return (
		<div className="flex items-stretch rounded-lg border border-border bg-card hover:border-border-hover transition-colors overflow-hidden">
			<div className="flex items-start gap-3 flex-1 min-w-0 p-4">
				<div className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-muted text-muted-foreground mt-0.5">
					<Icon size={15} />
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-sm font-semibold text-foreground">{page.label}</span>
						{pinned && (
							<Badge
								variant="outline"
								className="text-xs px-1.5 py-0 text-accent border-accent/30 bg-accent/10 font-medium"
							>
								Pinned
							</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{page.description}</p>
				</div>
			</div>
			<button
				type="button"
				onClick={onToggle}
				aria-label={pinned ? `Unpin ${page.label}` : `Pin ${page.label} to left nav`}
				className={`shrink-0 flex items-center gap-1.5 px-3 min-w-[44px] border-l border-border text-xs font-medium transition-colors ${
					pinned
						? 'text-accent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/20'
						: 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
				}`}
			>
				{pinned ? <PinOff size={13} /> : <Pin size={13} />}
				<span className="hidden sm:inline">{pinned ? 'Unpin' : 'Pin'}</span>
			</button>
		</div>
	)
}
