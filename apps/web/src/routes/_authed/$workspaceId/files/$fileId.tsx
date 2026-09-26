import { isHtml } from '@/components/files/file-body'
import { PinFileButton } from '@/components/files/pin-file-button'
import { ViewerStage } from '@/components/files/viewer-stage'
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
import { useFile } from '@/hooks/use-files'
import { useViewerPreferences } from '@/hooks/use-viewer-preferences'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { ApiError, type FileDetail } from '@/lib/api'
import { decodeBase64Utf8, downloadFile } from '@/lib/file-utils'
import { isPinned, togglePinnedFile } from '@/lib/pinned-files'
import {
	MOCKUP_VIEWPORT_PRESETS,
	type MockupViewportPreset,
	type ViewerVariantOverride,
	resolveViewerVariant,
} from '@/lib/viewer-detect'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Download, MessageSquare, MoreHorizontal } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/files/$fileId')({
	component: FileViewerPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function FileViewerPage() {
	const { fileId } = Route.useParams()
	const { workspace, workspaceId } = useWorkspace()
	const { data: file, isLoading, error } = useFile(workspaceId, fileId)
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const pinned = useMemo(() => isPinned(workspace, fileId), [workspace, fileId])
	const { variantOverride, mockupPreset, setVariantOverride, setMockupPreset } =
		useViewerPreferences(fileId)

	const handleTogglePin = useCallback(
		(id: string) => {
			updateWorkspace.mutate({ settings: { pinned_files: togglePinnedFile(workspace, id) } })
		},
		[updateWorkspace, workspace],
	)

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
				<ViewerShell>
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
				<ViewerShell>
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
					/>
				}
			/>
			<ViewerShell>
				<ViewerStage file={file} variantOverride={variantOverride} mockupPreset={mockupPreset} />
			</ViewerShell>
		</>
	)
}

// The route's outer container: strips the legacy `max-w-3xl mx-auto` column and
// gives the stage the full width of the shell. The layout's `[data-scroll-root]`
// is already `overflow-hidden` because PageHeader publishes `scrollLocked`, so
// this region is the viewer's only live scroll parent.
function ViewerShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
	)
}

// Right-side cluster on the shared detail bar: pin, download, then the Review
// toggle placeholder (Slice 3) and the ⋯ menu. Slice 2c wires the ⋯ menu for
// HTML files with the mockup viewport presets + a View-as override so a
// mockup misdetected as a deck (or vice versa) can be flipped by hand.
// Slice 3 extends the same menu with Pin-to-sidebar / Copy link / View source
// / Delete.
function TopBarActions({
	file,
	isPinned: pinnedFlag,
	onTogglePin,
	variantOverride,
	mockupPreset,
	onVariantOverrideChange,
	onMockupPresetChange,
}: {
	file: FileDetail
	isPinned: boolean
	onTogglePin: (id: string) => void
	variantOverride: ViewerVariantOverride
	mockupPreset: MockupViewportPreset
	onVariantOverrideChange: (next: ViewerVariantOverride) => void
	onMockupPresetChange: (next: MockupViewportPreset) => void
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
				variant="ghost"
				size="sm"
				disabled
				aria-label="Review panel — wired in Slice 3"
				title="Review — coming in Slice 3"
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

// The variant-override + preset radio groups render inline in the ⋯ menu.
// `viewAsValue` maps `null → 'auto'` so a Radix RadioGroup (which needs a
// non-null string value) can represent the "no override" state.
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

	// Resolve the variant with the *same* inputs the viewer uses so the menu
	// only shows the preset section when the stage is actually rendering the
	// mockup path. Auto-detect's DOM heuristic (viewer-detect.ts) reads the
	// first 8KB — the same slice the viewer resolves against.
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
				<DropdownMenuItem disabled title="More actions — coming in Slice 3">
					More actions coming soon
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
