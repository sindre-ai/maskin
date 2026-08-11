import { useObjects, useSearchObjects } from '@/hooks/use-objects'
import {
	type TaxonomyEntityType,
	trackCommandPaletteOpened,
	trackSearchResultOpened,
} from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { useChat } from '@/lib/chat-context'
import { useCommandPalette } from '@/lib/command-palette-context'
import { typeLabel } from '@/lib/constants'
import { highlightText } from '@/lib/search-highlight'
import { pushRecentObject, pushRecentSearch } from '@/lib/search-recents'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'

const SEARCH_DEBOUNCE_MS = 300

// ⌘K-search palette. Hosts both quick navigation (Actions/Navigation groups)
// and live object search (`shouldFilter={false}` + server-side ranking via
// useSearchObjects, so cmdk never reorders or drops results client-side).
// One command layer shared with the /search view — same query, same ranking.
export function CommandPalette() {
	const { open, setOpen } = useCommandPalette()
	const { workspaceId } = useWorkspace()
	const { setOpen: setChatOpen } = useChat()
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
		setChatOpen(true)
		setOpen(false)
	}, [setChatOpen, setOpen])

	// One `command_palette_opened` per open transition, fired on any route —
	// the success-metric funnel denominator. The /search *route* fires the
	// same event (surface: 'search_view') on mount, so the See-all footer's
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
		// Typed navigation to keep `q` in the URL's `search` chunk — same shape
		// the /search route's own updateSearch() commits against.
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
				setChatOpen(true)
				setOpen(false)
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
	}, [setChatOpen, setOpen])

	if (!open) return null

	// Empty state: quick-jump recent objects. Active query: server-ranked
	// results — never the client list, so both search surfaces show the same
	// ranking as the /search view.
	const items = hasQuery ? (searchResults ?? []) : (objects ?? []).slice(0, 20)

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] max-sm:items-end max-sm:pt-0">
			<div
				className="fixed inset-0 bg-black/50"
				onClick={() => setOpen(false)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') setOpen(false)
				}}
				role="button"
				tabIndex={0}
			/>
			<div className="relative w-full max-w-xl mx-auto bg-popover shadow-2xl max-sm:max-h-[92dvh] max-sm:flex max-sm:flex-col max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[calc(100%-2rem)] sm:rounded-xl">
				<Command
					shouldFilter={false}
					className="w-full max-sm:min-h-0 max-sm:flex-1 max-sm:flex max-sm:flex-col"
				>
					<Command.Input
						value={query}
						onValueChange={setQuery}
						placeholder="Search or jump to…"
						className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
						autoFocus
					/>
					<Command.List className="max-h-72 overflow-auto p-2 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1">
						<Command.Empty className="py-4 text-center text-sm text-muted-foreground">
							No results found.
						</Command.Empty>

						{!doesNotMatch('chat with agents') && (
							<Command.Group heading="Actions" className="text-xs text-muted-foreground px-2 py-1">
								<Command.Item
									className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
									onSelect={openChat}
								>
									Chat with agents…
									<span className="ml-auto text-xs text-muted-foreground">⌘J</span>
								</Command.Item>
							</Command.Group>
						)}

						{navItems.length > 0 && (
							<Command.Group
								heading="Navigation"
								className="text-xs text-muted-foreground px-2 py-1 mt-2"
							>
								{navItems.map((item) => (
									<Command.Item
										key={item.title}
										className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
										onSelect={() => navigateTo(item.path)}
									>
										{item.title}
									</Command.Item>
								))}
							</Command.Group>
						)}

						{items.length > 0 && (
							<Command.Group
								heading="Objects"
								className="text-xs text-muted-foreground px-2 py-1 mt-2"
							>
								{items.map((obj) => (
									<Command.Item
										key={obj.id}
										value={`${obj.title ?? ''} ${obj.type}`}
										className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
										onSelect={() => openObject(obj)}
									>
										<span className="min-w-0 flex-1 truncate">
											{highlightText(obj.title ?? 'Untitled', hasQuery ? query : '')}
										</span>
										<span className="ml-auto shrink-0 text-xs text-muted-foreground">
											{typeLabel(obj.type)}
										</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
					{hasQuery && items.length > 0 ? (
						<div className="shrink-0 border-t border-border">
							<Button
								variant="ghost"
								onClick={seeAll}
								className="w-full justify-start rounded-none px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
							>
								See all {items.length} result{items.length === 1 ? '' : 's'} →
							</Button>
						</div>
					) : (
						<div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
							<span>
								<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>{' '}
								Toggle
							</span>
							<span>
								<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘J</kbd> Chat
							</span>
							<span>
								<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>{' '}
								Close
							</span>
						</div>
					)}
				</Command>
			</div>
		</div>
	)
}
