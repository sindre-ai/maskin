import { useObjects, useSearchObjects } from '@/hooks/use-objects'
import {
	type TaxonomyEntityType,
	trackCommandPaletteOpened,
	trackSearchResultOpened,
} from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { useCommandPalette } from '@/lib/command-palette-context'
import { typeLabel } from '@/lib/constants'
import { highlightText } from '@/lib/search-highlight'
import { pushRecentObject, pushRecentSearch } from '@/lib/search-recents'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { ArrowRight, MessagesSquare, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

const SEARCH_DEBOUNCE_MS = 300

// v2 restyle — the ⌘K palette. Solid popover surface (no glass, no blur),
// warm-neutral tokens, indigo brand on the See-all footer, `.eyebrow` mono
// section labels matching the mockup's menu specimen. `shouldFilter={false}`
// + server-side ranking via useSearchObjects keeps the ordering identical to
// the /search view — one command layer shared across both surfaces.
export function CommandPalette() {
	const { open, setOpen } = useCommandPalette()
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	const [query, setQuery] = useState('')
	const [debouncedQuery, setDebouncedQuery] = useState('')
	const queryRef = useRef(query)
	useEffect(() => {
		queryRef.current = query
	}, [query])
	useEffect(() => {
		const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [query])

	const { data: searchResults } = useSearchObjects(workspaceId, { q: debouncedQuery })
	const { data: objects } = useObjects(workspaceId)

	const navigateTo = useCallback(
		(path: string) => {
			navigate({ to: path })
			setOpen(false)
		},
		[navigate, setOpen],
	)

	const openChat = useCallback(() => {
		navigateTo(`/${workspaceId}/chats/new`)
	}, [navigateTo, workspaceId])

	// One `command_palette_opened` per open transition, fired on any route —
	// the success-metric funnel denominator. The /search route fires the same
	// event (surface: 'search_view') on mount, so the See-all footer's
	// navigation to /search produces its palette-open event too.
	const prevOpen = useRef(open)
	useEffect(() => {
		if (open && !prevOpen.current) {
			trackCommandPaletteOpened({ surface: 'command_palette' })
		} else if (!open && prevOpen.current) {
			setQuery('')
		}
		prevOpen.current = open
	}, [open])

	const openObject = useCallback(
		(obj: ObjectResponse) => {
			trackSearchResultOpened({
				entity_id: obj.id,
				entity_type: obj.type as TaxonomyEntityType,
				surface: 'command_palette',
			})
			pushRecentObject(workspaceId, obj.id)
			navigateTo(`/${workspaceId}/objects/${obj.id}`)
		},
		[navigateTo, workspaceId],
	)

	const trimmedQuery = query.trim()
	const hasQuery = trimmedQuery.length > 0
	const doesNotMatch = (title: string) =>
		hasQuery && !title.toLowerCase().includes(trimmedQuery.toLowerCase())
	const navItems = [
		{ title: 'Bets Dashboard', path: `/${workspaceId}` },
		{ title: 'All Objects', path: `/${workspaceId}/objects` },
		{ title: 'Agents', path: `/${workspaceId}/agents` },
	].filter((n) => !doesNotMatch(n.title))

	const seeAll = useCallback(() => {
		if (!trimmedQuery) return
		pushRecentSearch(workspaceId, trimmedQuery)
		setOpen(false)
		// Typed navigation keeps `q` in the URL's search chunk — same shape the
		// /search route's updateSearch() commits against.
		navigate({
			to: '/$workspaceId/search',
			params: { workspaceId },
			search: { q: trimmedQuery },
		})
	}, [navigate, setOpen, trimmedQuery, workspaceId])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen((o) => !o)
			}
			if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
				// ⌘F opens search instead of the browser's find-in-page.
				e.preventDefault()
				setOpen(true)
			}
			if (e.key === 'j' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				openChat()
			}
			if (e.key === 'Escape') {
				// First Esc clears the query; a second Esc closes the panel.
				if (queryRef.current.trim()) {
					setQuery('')
				} else {
					setOpen(false)
				}
			}
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [openChat, setOpen])

	if (!open) return null

	// Empty state → quick-jump recent objects. Active query → server-ranked
	// results, never the client list, so both search surfaces show the same
	// order as the /search view.
	const items = hasQuery ? (searchResults ?? []) : (objects ?? []).slice(0, 20)

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] max-sm:items-end max-sm:pt-0">
			<button
				type="button"
				aria-label="Close palette"
				className="fixed inset-0 bg-foreground/40"
				onClick={() => setOpen(false)}
			/>
			<div className="relative w-full max-w-xl mx-auto overflow-hidden border border-border bg-popover text-popover-foreground shadow-xl max-sm:max-h-[92dvh] max-sm:flex max-sm:flex-col max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[calc(100%-2rem)] sm:rounded-2xl">
				<Command
					shouldFilter={false}
					className="w-full max-sm:min-h-0 max-sm:flex-1 max-sm:flex max-sm:flex-col"
				>
					<div className="flex items-center gap-2 border-b border-border px-3.5">
						<Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
						<Command.Input
							value={query}
							onValueChange={setQuery}
							placeholder="Search objects, jump to a route…"
							className="h-12 w-full bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground outline-none"
							autoFocus
						/>
						<kbd className="hidden shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
							Esc
						</kbd>
					</div>
					<Command.List className="max-h-[360px] overflow-auto p-1.5 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1">
						<Command.Empty className="px-3 py-8 text-center text-[13px] text-muted-foreground">
							No results found.
						</Command.Empty>

						{!doesNotMatch('chat with agents') && (
							<Command.Group>
								<div className="eyebrow px-2.5 pb-1 pt-2">Actions</div>
								<Command.Item
									className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-foreground cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
									onSelect={openChat}
								>
									<MessagesSquare aria-hidden="true" className="size-3.5 text-muted-foreground" />
									<span className="flex-1">Chat with agents…</span>
									<kbd className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
										⌘J
									</kbd>
								</Command.Item>
							</Command.Group>
						)}

						{navItems.length > 0 && (
							<Command.Group>
								<div className="eyebrow px-2.5 pb-1 pt-2">Navigation</div>
								{navItems.map((item) => (
									<Command.Item
										key={item.title}
										className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-foreground cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
										onSelect={() => navigateTo(item.path)}
									>
										<ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
										<span className="flex-1">{item.title}</span>
									</Command.Item>
								))}
							</Command.Group>
						)}

						{items.length > 0 && (
							<Command.Group>
								<div className="eyebrow px-2.5 pb-1 pt-2">Objects</div>
								{items.map((obj) => (
									<Command.Item
										key={obj.id}
										value={`${obj.title ?? ''} ${obj.type}`}
										className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-foreground cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
										onSelect={() => openObject(obj)}
									>
										<span className="min-w-0 flex-1 truncate">
											{highlightText(obj.title ?? 'Untitled', hasQuery ? query : '')}
										</span>
										<span className="ml-auto shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">
											{typeLabel(obj.type)}
										</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
					{hasQuery && items.length > 0 ? (
						<button
							type="button"
							onClick={seeAll}
							className="group flex shrink-0 items-center justify-between gap-2 border-t border-border bg-popover px-3.5 py-2.5 text-left transition-colors hover:bg-accent"
						>
							<span className="text-[12.5px] font-semibold text-brand transition-colors group-hover:text-brand-hover">
								See all {items.length} result{items.length === 1 ? '' : 's'}
							</span>
							<ArrowRight
								aria-hidden="true"
								className="size-3.5 text-brand transition-colors group-hover:text-brand-hover"
							/>
						</button>
					) : (
						<div className="flex shrink-0 items-center gap-3 border-t border-border bg-popover px-3.5 py-2 text-[11px] text-muted-foreground">
							<KeyHint keys={['⌘', 'K']}>Toggle</KeyHint>
							<KeyHint keys={['⌘', 'J']}>Chat</KeyHint>
							<KeyHint keys={['Esc']}>Close</KeyHint>
						</div>
					)}
				</Command>
			</div>
		</div>
	)
}

function KeyHint({ keys, children }: { keys: string[]; children: React.ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1">
			{keys.map((k) => (
				<kbd
					key={k}
					className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border border-border bg-secondary px-1 font-mono text-[10px] text-muted-foreground"
				>
					{k}
				</kbd>
			))}
			<span>{children}</span>
		</span>
	)
}
