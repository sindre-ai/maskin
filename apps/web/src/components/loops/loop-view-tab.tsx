import { LoopBriefingStage, isDeckView } from '@/components/loops/loop-briefing-stage'
import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { LoopViewChangePrompt } from '@/components/loops/loop-view-change-prompt'
import { LoopViewItemPanel } from '@/components/loops/loop-view-item-panel'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useFile } from '@/hooks/use-files'
import { useIsMobile } from '@/hooks/use-mobile'
import { decodeBase64Utf8 } from '@/lib/file-utils'
import type { ProposedChange } from '@/lib/loop-view-bridge'
import {
	EXPORT_FAILED_MESSAGE,
	type ExportFormat,
	type ExportPage,
	exportPages,
	exportPagesOfDocument,
} from '@/lib/view-export'
import { MAX_LOOP_VIEW_NAME_LENGTH } from '@maskin/shared'
import { Download, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

const EXPORT_CHOICES: { format: ExportFormat; label: string }[] = [
	{ format: 'markdown', label: 'Markdown' },
	{ format: 'pdf', label: 'PDF' },
	{ format: 'png', label: 'PNG' },
]

/**
 * One custom view as the body of its own tab, under a row with its name and a
 * "···" menu (refresh, rename, remove). A view that cannot be shown says why in a note;
 * Refresh, or leaving the tab and coming back (the page remounts it), retries.
 *
 * `onRename` / `onRemove` are omitted for a view the flow does not own (the
 * Briefings view), which then shows only Refresh.
 *
 * With the flag loop-view-export, the menu also offers Export (Markdown, PDF, PNG): the file is
 * built in the browser from what the view shows now, and a failure says so and saves nothing.
 *
 * A view that is a deck or briefing page shows in the same tall, fitted and paged viewer as the
 * Briefings tab, not the self-sizing frame, which shrinks a deck to a strip. Lists and dashboards
 * keep the frame.
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
	// Also raised by the menu's Refresh, which is the same reload run by hand.
	const [reloadToken, setReloadToken] = useState(0)
	const [refreshing, setRefreshing] = useState(false)
	const isMobile = useIsMobile()
	const [renaming, setRenaming] = useState(false)
	const [draft, setDraft] = useState(name ?? '')
	// Shares the file's cache entry with the frame below, so this costs no second load.
	const { data: file } = useFile(workspaceId, fileId)
	const isDeck = useMemo(() => (file ? isDeckView(file) : false), [file])
	const trimmed = draft.trim()
	const exportEnabled = useFeatureFlag('loop-view-export')
	// Filled by the view on screen; the page asks it for its pages only when Export is chosen.
	const exportRef = useRef<(() => Promise<ExportPage[]>) | null>(null)
	// The slide on screen, kept by the deck viewer.
	const deckPageRef = useRef(0)
	const [exporting, setExporting] = useState(false)
	const [exportFailed, setExportFailed] = useState(false)

	async function runExport(format: ExportFormat) {
		if (!file) return
		setExportFailed(false)
		setExporting(true)
		try {
			const pages = isDeck
				? await exportPagesOfDocument(
						file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content),
					)
				: await (exportRef.current?.() ?? Promise.reject(new Error('The view is not ready.')))
			await exportPages(format, pages, name ?? file.name, isDeck ? deckPageRef.current : 0)
		} catch (err) {
			console.error('[loop-view-tab] export failed', err)
			setExportFailed(true)
		} finally {
			setExporting(false)
		}
	}

	const header = (
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
				name !== undefined && <h2 className="text-sm font-semibold text-foreground">{name}</h2>
			)}
			<span className="flex-1" />
			{exportFailed && (
				<span role="alert" className="text-xs text-error">
					{EXPORT_FAILED_MESSAGE}
				</span>
			)}
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
					<DropdownMenuItem
						disabled={refreshing}
						onSelect={() => {
							// A view that could not be shown is mounted again, which tries it again.
							setFailure(null)
							setReloadToken((n) => n + 1)
						}}
					>
						<RefreshCw size={14} /> Refresh
					</DropdownMenuItem>
					{exportEnabled && (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={!file || Boolean(failure) || exporting}>
								<Download size={14} /> Export
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{EXPORT_CHOICES.map(({ format, label }) => (
									<DropdownMenuItem key={format} onSelect={() => void runExport(format)}>
										{label}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					)}
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
		</div>
	)

	if (isDeck) {
		return (
			<>
				{header}
				<LoopBriefingStage
					workspaceId={workspaceId}
					fileId={fileId}
					hideTitle
					pageRef={deckPageRef}
					reloadToken={reloadToken}
					onRefreshingChange={setRefreshing}
				/>
			</>
		)
	}
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
						onRefreshingChange={setRefreshing}
						reloadToken={reloadToken}
						exportRef={exportRef}
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
