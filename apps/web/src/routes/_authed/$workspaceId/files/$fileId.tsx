import { isHtml } from '@/components/files/file-body'
import { PinFileButton } from '@/components/files/pin-file-button'
import { ProvenanceStrip } from '@/components/files/provenance-strip'
import { type ReviewFilter, ReviewPanel } from '@/components/files/review-panel'
import { type StagePin, ViewerStage } from '@/components/files/viewer-stage'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { useActors } from '@/hooks/use-actors'
import { useAttachingObjects } from '@/hooks/use-attaching-objects'
import {
	useCreateFileComment,
	useFileComments,
	useSendFileCommentsRound,
	useUpdateFileComment,
} from '@/hooks/use-file-comments'
import { useFile } from '@/hooks/use-files'
import { useViewerPreferences } from '@/hooks/use-viewer-preferences'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { trackFileViewerPinPlaced } from '@/lib/analytics'
import { ApiError, type FileDetail } from '@/lib/api'
import {
	type FileCommentDraft,
	FileCommentsProvider,
	useFileCommentsContext,
} from '@/lib/file-comments-context'
import { decodeBase64Utf8, downloadFile } from '@/lib/file-utils'
import { isPinned, togglePinnedFile } from '@/lib/pinned-files'
import {
	MOCKUP_VIEWPORT_PRESETS,
	type MockupViewportPreset,
	type ViewerVariantOverride,
	resolveViewerVariant,
} from '@/lib/viewer-detect'
import { pickTarget, resolveProvenance } from '@/lib/viewer-provenance'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Download, MessageSquare, MoreHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

// URL search params for the deep-link contract (spec §Solution sketch):
//   /files/$fileId?round=<uuid>&panel=open
// `round` filters the panel to a single round; `panel=open` forces the panel
// visible on first paint so a driver clicking the rollup notification lands
// directly in the round they were pinged about.
interface FileViewerSearch {
	round?: string
	panel?: 'open' | 'closed'
}

export const Route = createFileRoute('/_authed/$workspaceId/files/$fileId')({
	component: FileViewerRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>): FileViewerSearch => ({
		round: typeof search.round === 'string' ? search.round : undefined,
		panel: search.panel === 'open' || search.panel === 'closed' ? search.panel : undefined,
	}),
})

function FileViewerRoute() {
	// The provider MUST wrap the page component so any drafts a user places
	// live for the lifetime of the file route. Mounting it inside
	// FileViewerPage would reset the store on every remount (e.g. auth-check
	// re-run), losing an in-progress draft the user just typed.
	return (
		<FileCommentsProvider>
			<FileViewerPage />
		</FileCommentsProvider>
	)
}

function FileViewerPage() {
	const { fileId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { workspace, workspaceId } = useWorkspace()

	const { data: file, isLoading, error } = useFile(workspaceId, fileId)
	const { data: attachers = [] } = useAttachingObjects(workspaceId, fileId)
	const { data: comments = [] } = useFileComments(workspaceId, fileId)
	const createComment = useCreateFileComment(workspaceId, fileId)
	const updateComment = useUpdateFileComment(workspaceId, fileId)
	const sendRound = useSendFileCommentsRound(workspaceId, fileId)
	const { data: actors } = useActors(workspaceId, { enabled: true })

	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const pinned = useMemo(() => isPinned(workspace, fileId), [workspace, fileId])
	const { variantOverride, mockupPreset, setVariantOverride, setMockupPreset } =
		useViewerPreferences(fileId)

	const {
		drafts,
		roundId,
		annotateMode,
		setAnnotateMode,
		exitAnnotateMode,
		addDraft,
		updateDraftBody,
		removeDraft,
		completeRound,
	} = useFileCommentsContext()

	// Deep-link → initial panel state. The route's search params own the
	// truth: `panel=open` opens the panel; `round=<id>` filters + opens.
	const [panelOpen, setPanelOpen] = useState<boolean>(
		search.panel === 'open' || Boolean(search.round),
	)
	const [filter, setFilter] = useState<ReviewFilter>('open')
	const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)

	// Post-send lock (spec §Solution sketch, §No-gos: send is final).
	const [sendPhase, setSendPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
	const [lockedDriverName, setLockedDriverName] = useState<string | null>(null)
	const [lockedDriverType, setLockedDriverType] = useState<'human' | 'agent' | null>(null)

	const resolvedProvenance = useMemo(() => {
		const base = resolveProvenance(attachers)
		return selectedTargetId ? pickTarget(base, selectedTargetId) : base
	}, [attachers, selectedTargetId])

	// Panel toggle: `C` when focus isn't in a text input. `Esc` exits
	// annotate mode. Both keys check for editable focus so we don't hijack
	// typing in the panel's Textarea. This lives on the route (not the stage)
	// so it works even when the stage doesn't have focus.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null
			const isEditable =
				target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
			if (event.key === 'Escape') {
				if (annotateMode) {
					event.preventDefault()
					exitAnnotateMode()
				}
				return
			}
			if (isEditable) return
			if (event.key === 'c' || event.key === 'C') {
				event.preventDefault()
				setPanelOpen((prev) => !prev)
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [annotateMode, exitAnnotateMode])

	const handleTogglePin = useCallback(
		(id: string) => {
			updateWorkspace.mutate({ settings: { pinned_files: togglePinnedFile(workspace, id) } })
		},
		[updateWorkspace, workspace],
	)

	const handlePinPlace = useCallback(
		(position: { x: number; y: number }, page: number | null) => {
			if (!file) return
			const draft = addDraft({
				fileId,
				page,
				positionDoc: position,
				body: '',
			})
			// Set panel visible so the user can see + edit the just-placed draft.
			setPanelOpen(true)
			// Emit the observability event with the resolved viewer variant so the
			// success metric can split by deck / mockup / single (spec
			// §Observability). Use the same detector the stage runs against.
			const html = file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
			const variant = resolveViewerVariant({
				filename: file.name,
				html,
				override: variantOverride,
			})
			trackFileViewerPinPlaced({
				file_id: fileId,
				page: draft.page,
				variant: variant === 'deck' ? 'deck' : variant === 'mockup' ? 'mockup' : 'single',
			})
		},
		[addDraft, file, fileId, variantOverride],
	)

	const handlePostDraft = useCallback(
		(draft: FileCommentDraft) => {
			if (draft.body.trim().length === 0) return
			createComment.mutate(
				{
					body: draft.body,
					page: draft.page,
					positionDoc: draft.positionDoc,
					selector: draft.selector,
					parentId: draft.parentId,
				},
				{
					onSuccess: () => {
						removeDraft(draft.tempId)
					},
				},
			)
		},
		[createComment, removeDraft],
	)

	const handleSendRound = useCallback(
		(targetObjectId: string) => {
			// Send-round is the ONLY point where the client-generated `roundId`
			// crosses the wire. All drafts on this file get stamped with this
			// same id transactionally on the server. Retries are safe: the
			// server upserts on `roundId` so a wobbly client can retry.
			//
			// Pre-flight: post any unsent local drafts as server rows and grab
			// their ids. The server's transactional round-send stamps every
			// commentId under the same roundId. If a draft is empty we skip it.
			const workflow = async () => {
				setSendPhase('sending')
				const commentIds: string[] = []
				const postedTempIds: string[] = []
				for (const draft of drafts) {
					if (draft.body.trim().length === 0) continue
					try {
						const posted = await createComment.mutateAsync({
							body: draft.body,
							page: draft.page,
							positionDoc: draft.positionDoc,
							selector: draft.selector,
							parentId: draft.parentId,
						})
						commentIds.push(posted.id)
						postedTempIds.push(draft.tempId)
						// Drop the local draft as soon as it is a server row, so a
						// failed send (or a later failed draft) can be retried without
						// posting this one twice.
						removeDraft(draft.tempId)
					} catch {
						setSendPhase('idle')
						return
					}
				}
				for (const row of comments) {
					if (row.roundId === null) commentIds.push(row.id)
				}
				if (commentIds.length === 0) {
					setSendPhase('idle')
					return
				}
				const target = attachers.find((a) => a.id === targetObjectId)
				try {
					await sendRound.mutateAsync({
						roundId,
						targetObjectId,
						commentIds,
						driverId: target?.driverId ?? null,
					})
					const driver =
						target?.driverId && actors ? actors.find((a) => a.id === target.driverId) : null
					setLockedDriverName(driver?.name ?? 'driver')
					setLockedDriverType(
						target?.driverType === 'agent'
							? 'agent'
							: target?.driverType === 'human'
								? 'human'
								: null,
					)
					setSendPhase('sent')
					completeRound(postedTempIds)
				} catch {
					setSendPhase('idle')
				}
			}
			void workflow()
		},
		[
			drafts,
			comments,
			createComment,
			sendRound,
			roundId,
			attachers,
			actors,
			completeRound,
			removeDraft,
		],
	)

	// Pins overlaid on the stage — every posted comment shows as a saved pin,
	// every unsent draft as a draft pin. Pins render only for the file
	// currently on screen; filtering by page happens inside the overlay.
	const stagePins = useMemo<StagePin[]>(() => {
		const fromComments: StagePin[] = comments.map((c, idx) => ({
			id: c.id,
			page: c.page,
			positionDoc: c.positionDoc,
			kind: 'saved',
			label: String(idx + 1),
		}))
		const fromDrafts: StagePin[] = drafts
			.filter((d) => d.fileId === fileId)
			.map((d) => ({
				id: d.tempId,
				page: d.page,
				positionDoc: d.positionDoc,
				kind: 'draft',
			}))
		return [...fromComments, ...fromDrafts]
	}, [comments, drafts, fileId])

	if (isLoading) {
		return (
			<>
				<PageHeader
					scrollLocked
					crumb={{
						parentLabel: 'Files',
						parentTo: '/$workspaceId/files',
						parentParams: { workspaceId },
						label: 'Loading…',
					}}
				/>
				<ViewerShell panelOpen={false} strip={null}>
					<div
						className="flex h-full w-full items-center justify-center bg-muted"
						data-viewer-state="loading"
					>
						<Spinner />
					</div>
				</ViewerShell>
			</>
		)
	}

	if (error || !file) {
		const is404 = error instanceof ApiError && error.status === 404
		return (
			<>
				<PageHeader
					scrollLocked
					crumb={{
						parentLabel: 'Files',
						parentTo: '/$workspaceId/files',
						parentParams: { workspaceId },
						label: is404 ? 'Not found' : 'Failed to load',
					}}
				/>
				<ViewerShell panelOpen={false} strip={null}>
					<div
						className="flex h-full w-full items-center justify-center bg-muted p-8"
						data-viewer-state={is404 ? 'file-404' : 'load-error'}
					>
						<EmptyState
							title={is404 ? 'File not found' : 'Failed to load file'}
							description={
								is404
									? 'This file may have been deleted, or you might not have access to it.'
									: error?.message
							}
						/>
					</div>
				</ViewerShell>
			</>
		)
	}

	const strip = (
		<ProvenanceStrip
			workspaceId={workspaceId}
			attachers={attachers}
			selectedTargetId={selectedTargetId}
			onSelectTarget={setSelectedTargetId}
		/>
	)

	return (
		<>
			<PageHeader
				scrollLocked
				crumb={{
					parentLabel: 'Files',
					parentTo: '/$workspaceId/files',
					parentParams: { workspaceId },
					label: file.name,
				}}
				actions={
					<TopBarActions
						file={file}
						isPinned={pinned}
						onTogglePin={handleTogglePin}
						variantOverride={variantOverride}
						mockupPreset={mockupPreset}
						onVariantOverrideChange={setVariantOverride}
						onMockupPresetChange={setMockupPreset}
						panelOpen={panelOpen}
						onTogglePanel={() => setPanelOpen((prev) => !prev)}
						annotateMode={annotateMode}
						onToggleAnnotate={() => {
							setAnnotateMode(!annotateMode)
							if (!annotateMode) setPanelOpen(true)
						}}
					/>
				}
			/>
			<ViewerShell panelOpen={panelOpen} strip={strip}>
				<div className="flex min-h-0 flex-1 overflow-hidden">
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<ViewerStage
							file={file}
							variantOverride={variantOverride}
							mockupPreset={mockupPreset}
							annotateMode={annotateMode}
							pins={stagePins}
							onPinPlace={handlePinPlace}
						/>
					</div>
					{panelOpen && (
						<ReviewPanel
							fileId={fileId}
							workspaceId={workspaceId}
							comments={comments}
							drafts={drafts}
							filter={filter}
							onFilterChange={setFilter}
							provenance={resolvedProvenance}
							sendState={{
								phase: sendPhase,
								lockedDriverName,
								lockedDriverType,
							}}
							onSendRound={handleSendRound}
							onUpdateDraftBody={updateDraftBody}
							onRemoveDraft={removeDraft}
							onPostDraft={handlePostDraft}
							onResolveComment={(c) =>
								updateComment.mutate({ commentId: c.id, data: { resolved: true } })
							}
							onReopenComment={(c) =>
								updateComment.mutate({ commentId: c.id, data: { resolved: false } })
							}
							roundFilter={search.round ?? null}
							onClearRoundFilter={() =>
								navigate({
									search: (prev) => ({ ...prev, round: undefined }),
									params: (p) => p,
								})
							}
						/>
					)}
				</div>
			</ViewerShell>
		</>
	)
}

function ViewerShell({
	children,
	panelOpen: _panelOpen,
	strip,
}: {
	children: React.ReactNode
	panelOpen: boolean
	strip: React.ReactNode | null
}) {
	// The strip is a thin band under the top bar; below it the shell splits
	// stage + panel. `overflow-hidden` on the outer keeps scroll owned by the
	// stage's own viewport (spec §Route + shell: "the viewer owns internal
	// scroll").
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
			{strip}
			<div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
		</div>
	)
}

function TopBarActions({
	file,
	isPinned: pinnedFlag,
	onTogglePin,
	variantOverride,
	mockupPreset,
	onVariantOverrideChange,
	onMockupPresetChange,
	panelOpen,
	onTogglePanel,
	annotateMode,
	onToggleAnnotate,
}: {
	file: FileDetail
	isPinned: boolean
	onTogglePin: (id: string) => void
	variantOverride: ViewerVariantOverride
	mockupPreset: MockupViewportPreset
	onVariantOverrideChange: (next: ViewerVariantOverride) => void
	onMockupPresetChange: (next: MockupViewportPreset) => void
	panelOpen: boolean
	onTogglePanel: () => void
	annotateMode: boolean
	onToggleAnnotate: () => void
}) {
	return (
		<div className="flex items-center gap-1">
			<PinFileButton file={file} isPinned={pinnedFlag} onToggle={onTogglePin} />
			<Button
				variant="ghost"
				size="sm"
				onClick={() => downloadFile(file)}
				aria-label="Download file"
			>
				<Download size={14} />
			</Button>
			<Button
				variant={annotateMode ? 'secondary' : 'ghost'}
				size="sm"
				onClick={onToggleAnnotate}
				aria-label="Toggle annotate mode"
				aria-pressed={annotateMode}
			>
				Annotate
			</Button>
			<Button
				variant={panelOpen ? 'secondary' : 'ghost'}
				size="sm"
				onClick={onTogglePanel}
				aria-label="Toggle review panel"
				aria-pressed={panelOpen}
				title="Toggle review panel (C)"
			>
				<MessageSquare size={14} />
				Review
			</Button>
			<ViewerMoreMenu
				file={file}
				variantOverride={variantOverride}
				mockupPreset={mockupPreset}
				onVariantOverrideChange={onVariantOverrideChange}
				onMockupPresetChange={onMockupPresetChange}
			/>
		</div>
	)
}

const VIEW_AS_AUTO = 'auto'

const VIEW_AS_OPTIONS: Array<{ value: string; label: string; override: ViewerVariantOverride }> = [
	{ value: VIEW_AS_AUTO, label: 'Auto (detect)', override: null },
	{ value: 'deck', label: 'Deck', override: 'deck' },
	{ value: 'mockup', label: 'Mockup', override: 'mockup' },
]

const PRESET_LABELS: Record<MockupViewportPreset, string> = {
	desktop: 'Desktop',
	tablet: 'Tablet',
	phone: 'Phone',
}

function ViewerMoreMenu({
	file,
	variantOverride,
	mockupPreset,
	onVariantOverrideChange,
	onMockupPresetChange,
}: {
	file: FileDetail
	variantOverride: ViewerVariantOverride
	mockupPreset: MockupViewportPreset
	onVariantOverrideChange: (next: ViewerVariantOverride) => void
	onMockupPresetChange: (next: MockupViewportPreset) => void
}) {
	const html = isHtml(file.mimeType)

	const resolvedVariant = useMemo(() => {
		if (!html) return null
		const text = file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
		return resolveViewerVariant({ filename: file.name, html: text, override: variantOverride })
	}, [html, file.encoding, file.content, file.name, variantOverride])

	if (!html) {
		return (
			<Button
				variant="ghost"
				size="sm"
				disabled
				aria-label="More actions — no options for this file type"
				title="More — no options for this file type"
			>
				<MoreHorizontal size={14} />
			</Button>
		)
	}

	const viewAsValue =
		VIEW_AS_OPTIONS.find((option) => option.override === variantOverride)?.value ?? VIEW_AS_AUTO

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" aria-label="More actions">
					<MoreHorizontal size={14} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<DropdownMenuLabel>View as</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={viewAsValue}
					onValueChange={(value) => {
						const match = VIEW_AS_OPTIONS.find((option) => option.value === value)
						onVariantOverrideChange(match ? match.override : null)
					}}
				>
					{VIEW_AS_OPTIONS.map((option) => (
						<DropdownMenuRadioItem key={option.value} value={option.value}>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				{resolvedVariant === 'mockup' && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Viewport</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={mockupPreset}
							onValueChange={(value) => {
								if (value in MOCKUP_VIEWPORT_PRESETS) {
									onMockupPresetChange(value as MockupViewportPreset)
								}
							}}
						>
							{(Object.keys(MOCKUP_VIEWPORT_PRESETS) as MockupViewportPreset[]).map((preset) => {
								const dims = MOCKUP_VIEWPORT_PRESETS[preset]
								return (
									<DropdownMenuRadioItem key={preset} value={preset}>
										<span>{PRESET_LABELS[preset]}</span>
										<span className="ml-auto pl-4 font-mono text-xs text-muted-foreground tabular-nums">
											{dims.w}×{dims.h}
										</span>
									</DropdownMenuRadioItem>
								)
							})}
						</DropdownMenuRadioGroup>
					</>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem disabled title="More actions — coming in later slice">
					More actions coming soon
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
