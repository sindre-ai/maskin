import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { MAX_LOOP_VIEW_NAME_LENGTH } from '@maskin/shared'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'

/**
 * One custom view as the body of its own tab, under a row with its name and a
 * "···" menu (rename, remove). A view that cannot be shown says why in a note;
 * leaving the tab and coming back (the page remounts it) retries.
 *
 * `onRename` / `onRemove` are omitted for a view the flow does not own (the
 * Briefings view), which then shows no menu.
 */
export function LoopViewTab({
	workspaceId,
	fileId,
	name,
	onRename,
	onRemove,
	busy = false,
}: {
	workspaceId: string
	fileId: string
	name?: string
	onRename?: (name: string) => void
	onRemove?: () => void
	busy?: boolean
}) {
	const [failure, setFailure] = useState<string | null>(null)
	const [renaming, setRenaming] = useState(false)
	const [draft, setDraft] = useState(name ?? '')
	const hasMenu = Boolean(onRename || onRemove)
	const trimmed = draft.trim()

	const header =
		name !== undefined || hasMenu ? (
			<div className="mb-4 flex items-center gap-2.5 px-1">
				{renaming ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault()
							if (!trimmed || !onRename) return
							onRename(trimmed)
							setRenaming(false)
						}}
					>
						<Input
							autoFocus
							value={draft}
							maxLength={MAX_LOOP_VIEW_NAME_LENGTH}
							aria-label="View name"
							onChange={(e) => setDraft(e.target.value)}
							className="w-52"
						/>
						<Button type="submit" size="sm" disabled={!trimmed || busy}>
							Save
						</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
							Cancel
						</Button>
					</form>
				) : (
					<h2 className="text-sm font-semibold text-foreground">{name}</h2>
				)}
				<span className="flex-1" />
				{hasMenu && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-muted-foreground"
								aria-label="View actions"
								disabled={busy}
							>
								<MoreHorizontal size={15} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{onRename && (
								<DropdownMenuItem
									onSelect={() => {
										setDraft(name ?? '')
										setRenaming(true)
									}}
								>
									<Pencil size={14} /> Rename
								</DropdownMenuItem>
							)}
							{onRemove && (
								<DropdownMenuItem onSelect={onRemove} className="text-error focus:text-error">
									<Trash2 size={14} /> Remove view
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		) : null

	// A failed view is unmounted, not just annotated, so its frame is gone from the page.
	if (failure) {
		return (
			<>
				{header}
				<p role="alert" className="text-sm text-muted-foreground">
					This view can't be shown: {failure}
				</p>
			</>
		)
	}
	return (
		<>
			{header}
			<LoopCustomView workspaceId={workspaceId} fileId={fileId} onFailure={setFailure} />
		</>
	)
}
