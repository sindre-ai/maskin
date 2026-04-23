import { useObjects } from '@/hooks/use-objects'
import { useSindre } from '@/lib/sindre-context'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import { useCallback, useEffect, useState } from 'react'

export function CommandPalette() {
	const [open, setOpen] = useState(false)
	const { workspaceId } = useWorkspace()
	const { data: objects } = useObjects(workspaceId)
	const { setOpen: setSindreOpen } = useSindre()
	const navigate = useNavigate()

	const navigateTo = useCallback(
		(path: string) => {
			navigate({ to: path })
			setOpen(false)
		},
		[navigate],
	)

	const openSindre = useCallback(() => {
		setSindreOpen(true)
		setOpen(false)
	}, [setSindreOpen])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen((o) => !o)
			}
			if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setOpen(true)
			}
			if (e.key === 'j' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				setSindreOpen(true)
				setOpen(false)
			}
			if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				navigateTo(`/${workspaceId}/objects/${crypto.randomUUID()}`)
			}
			if (e.key === 'Escape') {
				setOpen(false)
			}
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [navigateTo, workspaceId, setSindreOpen])

	if (!open) return null

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
			<div
				className="fixed inset-0 bg-black/50"
				onClick={() => setOpen(false)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') setOpen(false)
				}}
				role="button"
				tabIndex={0}
			/>
			<div className="relative w-full max-w-lg bg-popover rounded-xl shadow-2xl">
				<Command className="w-full">
					<Command.Input
						placeholder="Search objects, navigate..."
						className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
						autoFocus
					/>
					<Command.List className="max-h-72 overflow-auto p-2">
						<Command.Empty className="py-4 text-center text-sm text-muted-foreground">
							No results found.
						</Command.Empty>

						<Command.Group heading="Actions" className="text-xs text-muted-foreground px-2 py-1">
							<Command.Item
								className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
								onSelect={openSindre}
							>
								Talk to Sindre…
								<span className="ml-auto text-xs text-muted-foreground">⌘J</span>
							</Command.Item>
						</Command.Group>

						<Command.Group
							heading="Navigation"
							className="text-xs text-muted-foreground px-2 py-1 mt-2"
						>
							<Command.Item
								className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
								onSelect={() => navigateTo(`/${workspaceId}`)}
							>
								Bets Dashboard
							</Command.Item>
							<Command.Item
								className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
								onSelect={() => navigateTo(`/${workspaceId}/objects`)}
							>
								All Objects
							</Command.Item>
							<Command.Item
								className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
								onSelect={() => navigateTo(`/${workspaceId}/activity`)}
							>
								Activity Feed
							</Command.Item>
							<Command.Item
								className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
								onSelect={() => navigateTo(`/${workspaceId}/agents`)}
							>
								Agents
							</Command.Item>
						</Command.Group>

						{(objects?.length ?? 0) > 0 && (
							<Command.Group
								heading="Objects"
								className="text-xs text-muted-foreground px-2 py-1 mt-2"
							>
								{objects?.slice(0, 20).map((obj) => (
									<Command.Item
										key={obj.id}
										value={`${obj.title} ${obj.type} ${obj.status}`}
										className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground cursor-pointer data-[selected]:bg-accent data-[selected]:text-accent-foreground"
										onSelect={() => navigateTo(`/${workspaceId}/objects/${obj.id}`)}
									>
										<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
										<span className="text-xs text-muted-foreground">{obj.type}</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
					<div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
						<span>
							<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘F</kbd> Search
						</span>
						<span>
							<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd> Toggle
						</span>
						<span>
							<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘J</kbd> Sindre
						</span>
						<span>
							<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘N</kbd> New
							object
						</span>
						<span>
							<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd> Close
						</span>
					</div>
				</Command>
			</div>
		</div>
	)
}
