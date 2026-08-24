import { useCommandPalette } from '@/lib/command-palette-context'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

/**
 * The shared top nav's workspace search — mockup lines 202–212.
 *
 * Collapsed it is a 30px icon button; opening it expands an inline field that
 * grows to at most 320px. Enter commits the query to the /search page, which is
 * the source of truth for results; this field only carries the query there.
 * The ⌘K chip opens the command palette, which is a different affordance —
 * jump-anywhere and run-an-action, not text search.
 */
export function NavSearch() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { setOpen: setPaletteOpen } = useCommandPalette()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const inputRef = useRef<HTMLInputElement>(null)

	const close = useCallback(() => {
		setOpen(false)
		setQuery('')
	}, [])

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => {
					setOpen(true)
					// The input mounts this tick; focus once it exists.
					requestAnimationFrame(() => inputRef.current?.focus())
				}}
				aria-label="Search the workspace"
				aria-expanded={false}
				title="Search the workspace"
				className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground transition-colors duration-150 hover:border-border-hover hover:text-foreground"
			>
				<Search aria-hidden="true" className="size-[15px]" />
			</button>
		)
	}

	return (
		// Collapse is handled on the wrapper, not the input: clicking the clear or
		// ⌘K button blurs the input, and collapsing on that blur would unmount the
		// button before its click landed. Only focus leaving the whole field counts.
		<div
			onBlur={(e) => {
				if (query) return
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
				setOpen(false)
			}}
			className="flex h-[30px] min-w-0 max-w-[320px] flex-[1_1_clamp(210px,26vw,320px)] items-center gap-[7px] rounded-lg border border-border bg-background pl-[11px] pr-2 text-muted-foreground focus-within:border-border-hover"
		>
			<Search aria-hidden="true" className="size-[14px] shrink-0" />
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') {
						close()
						return
					}
					if (e.key === 'Enter' && query.trim()) {
						navigate({
							to: '/$workspaceId/search',
							params: { workspaceId },
							search: { q: query.trim() },
						})
					}
				}}
				placeholder="Search chats, loops, agents, objects…"
				aria-label="Search the workspace"
				className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
			/>
			{query && (
				<button
					type="button"
					onClick={close}
					aria-label="Clear search"
					title="Clear"
					className="grid size-[18px] shrink-0 place-items-center rounded text-border-strong transition-colors duration-150 hover:bg-muted hover:text-foreground"
				>
					<X aria-hidden="true" className="size-3" />
				</button>
			)}
			<button
				type="button"
				onClick={() => setPaletteOpen(true)}
				title="Commands — jump anywhere or run an action · ⌘K"
				aria-label="Open commands"
				className="shrink-0 rounded-[5px] border border-border bg-muted px-[5px] py-[3px] font-mono text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:border-border-hover hover:bg-background hover:text-foreground"
			>
				⌘K
			</button>
		</div>
	)
}
