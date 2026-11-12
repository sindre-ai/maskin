import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { LoopViewChangePrompt } from '@/components/loops/loop-view-change-prompt'
import { LoopViewItemPanel } from '@/components/loops/loop-view-item-panel'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ProposedChange } from '@/lib/loop-view-bridge'
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
 *
 * When a view asks to open an item, its card shows beside the view (a sheet on a phone), where
 * the person can change its status or approve it. With the flag off, Open goes to the object's
 * page as before.
 *
 * When a view proposes a new day or time for an item, the page asks the person to confirm and
 * saves only on yes (flag loop-view-date-change; off, the proposal is ignored). The view never
 * saves anything itself.
 */
export function LoopViewTab({
	workspaceId,
	loopId,
	fileId,
	name,
	onRename,
	onRemove,
	busy = false,
}: {
	workspaceId: string
	loopId: string
	fileId: string
	name?: string
	/** Resolves true once saved; the rename field stays open on false. */
	onRename?: (name: string) => Promise<boolean> | boolean
	onRemove?: () => void
	busy?: boolean
}) {
	const [failure, setFailure] = useState<string | null>(null)
	const [openId, setOpenId] = useState<string | null>(null)
	const itemPanel = useFeatureFlag('loop-view-item-panel')
	const dateChange = useFeatureFlag('loop-view-date-change')
	const [proposed, setProposed] = useState<ProposedChange | null>(null)
	// Raised on each saved change so the view reloads its lists and shows the new value.
	const [reloadToken, setReloadToken] = useState(0)
	const isMobile = useIsMobile()
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
						onSubmit={async (e) => {
							e.preventDefault()
							if (!trimmed || !onRename) return
							if (await onRename(trimmed)) setRenaming(false)
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
	const panel =
		itemPanel && openId !== null ? (
			<LoopViewItemPanel
				workspaceId={workspaceId}
				loopId={loopId}
				objectId={openId}
				onClose={() => setOpenId(null)}
			/>
		) : null
	// The view keeps one place in the tree whether or not the panel is open, so opening an item
	// never reloads it.
	return (
		<>
			{header}
			<div className="flex min-w-0 items-start gap-4">
				<div className="min-w-0 flex-1">
					<LoopCustomView
						workspaceId={workspaceId}
						fileId={fileId}
						onFailure={setFailure}
						onOpenItem={itemPanel ? setOpenId : undefined}
						onProposeChange={dateChange ? setProposed : undefined}
						reloadToken={reloadToken}
					/>
				</div>
				{panel && !isMobile ? (
					<aside className="sticky top-4 w-[26rem] max-w-[45%] shrink-0">{panel}</aside>
				) : null}
				{panel && isMobile ? (
					<Sheet open onOpenChange={(open) => !open && setOpenId(null)}>
						<SheetContent
							side="right"
							hideCloseButton
							className="w-full overflow-y-auto p-4 sm:max-w-none"
						>
							<SheetTitle className="sr-only">Item</SheetTitle>
							<SheetDescription className="sr-only">
								The item you opened from the view
							</SheetDescription>
							{panel}
						</SheetContent>
					</Sheet>
				) : null}
				{dateChange ? (
					<LoopViewChangePrompt
						workspaceId={workspaceId}
						loopId={loopId}
						change={proposed}
						onCancel={() => setProposed(null)}
						onSaved={() => {
							setProposed(null)
							setReloadToken((n) => n + 1)
						}}
					/>
				) : null}
			</div>
		</>
	)
}
