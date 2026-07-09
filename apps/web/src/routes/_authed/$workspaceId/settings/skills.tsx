import {
	DisplayPanel,
	type DisplayPanelColumn,
} from '@/components/objects/data-table/display-panel'
import { EmptyState } from '@/components/shared/empty-state'
import { FormError } from '@/components/shared/form-error'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { Textarea } from '@/components/ui/textarea'
import {
	useCreateWorkspaceSkill,
	useDeleteWorkspaceSkill,
	useUpdateWorkspaceSkill,
	useUploadWorkspaceSkill,
	useWorkspaceSkill,
	useWorkspaceSkillFiles,
	useWorkspaceSkills,
} from '@/hooks/use-workspace-skills'
import { ApiError, type WorkspaceSkillListItem, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { parseSkillMd, skillNameSchema } from '@maskin/shared'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { zipSync } from 'fflate'
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Download,
	FileUp,
	Folder,
	FolderUp,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SkillSort = 'name' | 'createdAt' | 'updatedAt'
type SkillOrder = 'asc' | 'desc'

const SKILL_SORT_COLUMNS: DisplayPanelColumn[] = [
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'createdAt', label: 'Created', canHide: false },
	{ id: 'updatedAt', label: 'Updated', canHide: false },
]

const SKILL_SORT_IDS = new Set<SkillSort>(['name', 'createdAt', 'updatedAt'])

export const Route = createFileRoute('/_authed/$workspaceId/settings/skills')({
	component: SkillsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		sort:
			typeof search.sort === 'string' && SKILL_SORT_IDS.has(search.sort as SkillSort)
				? (search.sort as SkillSort)
				: ('name' as SkillSort),
		order:
			typeof search.order === 'string' && (search.order === 'asc' || search.order === 'desc')
				? (search.order as SkillOrder)
				: ('asc' as SkillOrder),
	}),
})

const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when to use it
---

Instructions for the agent...
`

const MAX_UPLOAD_RETRIES = 5

// The drop-zone, file picker, and Replace bundle picker all accept the same
// set. Browsers vary on `.zip` MIME — Safari sends 'application/zip', Chrome
// sometimes sends 'application/x-zip-compressed', so we list both extension
// and MIME forms to keep the OS picker permissive.
const SKILL_UPLOAD_ACCEPT =
	'.md,.markdown,text/markdown,.zip,application/zip,application/x-zip-compressed'

// Mirrors apps/dev/src/lib/skill-bundles.ts (SKILL_BUNDLE_MAX_*). Not shared
// code — apps/web can't import from apps/dev — so this is a client-side
// pre-check that fails fast with a friendly message; the server enforces the
// real limits regardless.
const FOLDER_MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 // 10 MB
const FOLDER_MAX_ENTRY_BYTES = 5 * 1024 * 1024 // 5 MB
const FOLDER_MAX_ENTRIES = 500

type DialogState =
	| { kind: 'closed' }
	| { kind: 'create' }
	| { kind: 'edit'; name: string }
	| { kind: 'delete'; name: string }

type UploadSummary = { imported: number; failed: { name: string; reason: string }[] }

function SkillsPage() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const { sort, order } = useSearch({ from: '/_authed/$workspaceId/settings/skills' })
	const { data: skills, isLoading } = useWorkspaceSkills(workspaceId)
	const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
	const createMutation = useCreateWorkspaceSkill(workspaceId)
	const uploadMutation = useUploadWorkspaceSkill(workspaceId)
	const [isDragging, setIsDragging] = useState(false)
	const [isUploading, setIsUploading] = useState(false)
	const [summary, setSummary] = useState<UploadSummary | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const folderInputRef = useRef<HTMLInputElement>(null)

	const rawList = skills ?? []
	const existingNames = rawList.map((s) => s.name)

	const list = useMemo(() => sortSkills(rawList, sort, order), [rawList, sort, order])

	const updateSort = useCallback(
		(updates: { sort?: SkillSort; order?: SkillOrder }) => {
			navigate({
				to: '/$workspaceId/settings/skills',
				params: { workspaceId },
				search: { sort, order, ...updates },
				replace: true,
			})
		},
		[navigate, workspaceId, sort, order],
	)

	const handleFiles = useCallback(
		async (files: FileList | File[]) => {
			const fileList = Array.from(files).filter((f) => f.size > 0)
			if (fileList.length === 0) return

			setIsUploading(true)
			setSummary(null)

			// Track names claimed by in-flight .md uploads so two invalid files that
			// sanitise to the same base name get unique suffixes. Zip uploads go
			// through the multipart endpoint, which derives the name server-side.
			const claimed = new Set(existingNames)
			const result: UploadSummary = { imported: 0, failed: [] }

			const uploads = fileList.map(async (file) => {
				const isZip = /\.zip$/i.test(file.name)
				if (isZip) {
					try {
						// Server is the source of truth for is_folder / is_valid — the
						// row lands either way, malformed bundles surface via AlertTriangle
						// on the row instead of bouncing here.
						await uploadMutation.mutateAsync({ file })
						result.imported++
					} catch (err) {
						const reason =
							err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed'
						result.failed.push({ name: file.name, reason })
					}
					return
				}

				const text = await file.text()
				const { baseName, content } = toSkillUpload(text, file.name)
				let name = uniqueName(baseName, claimed)
				claimed.add(name)

				for (let attempt = 0; attempt < MAX_UPLOAD_RETRIES; attempt++) {
					try {
						await createMutation.mutateAsync({ name, content })
						result.imported++
						return
					} catch (err) {
						if (err instanceof ApiError && err.status === 409) {
							claimed.add(name)
							name = uniqueName(baseName, claimed)
							claimed.add(name)
							continue
						}
						const reason =
							err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed'
						result.failed.push({ name: file.name, reason })
						return
					}
				}
				result.failed.push({ name: file.name, reason: 'Too many name collisions' })
			})

			await Promise.allSettled(uploads)
			setIsUploading(false)
			setSummary(result)
		},
		[createMutation, uploadMutation, existingNames],
	)

	const openFilePicker = useCallback(() => inputRef.current?.click(), [])
	const openFolderPicker = useCallback(() => folderInputRef.current?.click(), [])

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (e.target.files && e.target.files.length > 0) {
				void handleFiles(e.target.files)
			}
			e.target.value = ''
		},
		[handleFiles],
	)

	const handleFolderChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const files = e.target.files ? Array.from(e.target.files) : []
			e.target.value = ''
			if (files.length === 0) return

			setIsUploading(true)
			setSummary(null)
			const result = await zipFolderFiles(files)
			if ('error' in result) {
				setIsUploading(false)
				const folderName = files[0].webkitRelativePath.split('/')[0] || files[0].name
				setSummary({ imported: 0, failed: [{ name: folderName, reason: result.error }] })
				return
			}
			// handleFiles owns isUploading/summary from here — it routes the zipped
			// folder through the same multipart path a hand-zipped .zip takes.
			await handleFiles([result.file])
		},
		[handleFiles],
	)

	const dropHandlers = {
		onDragOver: (e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(true)
		},
		onDragLeave: () => setIsDragging(false),
		onDrop: (e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(false)
			if (e.dataTransfer.files.length > 0) {
				void handleFiles(e.dataTransfer.files)
			}
		},
	}

	const headerActions = (
		<div className="flex items-center gap-2 shrink-0">
			<DisplayPanel
				columns={SKILL_SORT_COLUMNS}
				sort={sort}
				onSortChange={(value) => updateSort({ sort: value as SkillSort })}
				order={order}
				onOrderChange={(value) => updateSort({ order: value })}
				showView={false}
			/>
			<ImportSkillButton
				onImportFile={openFilePicker}
				onImportFolder={openFolderPicker}
				disabled={isUploading}
			/>
			<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
				<Plus size={14} className="mr-1" />
				Create skill
			</Button>
		</div>
	)

	return (
		<div>
			<div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-sm text-muted-foreground min-w-0">
					Shared skills available to agents in this workspace.
				</p>
				{headerActions}
			</div>

			{isLoading ? (
				<ListSkeleton />
			) : list.length === 0 ? (
				<div
					{...dropHandlers}
					className={cn(
						'rounded-lg border-2 border-dashed transition-colors',
						isDragging ? 'border-accent bg-accent/5' : 'border-border',
						isUploading && 'pointer-events-none opacity-50',
					)}
				>
					<EmptyState
						title={
							isUploading
								? 'Uploading skill files...'
								: isDragging
									? 'Drop SKILL.md files or skill bundles (.zip) to import'
									: 'No skills yet'
						}
						description="Create a skill, browse for SKILL.md or .zip bundles, import a folder directly, or drag and drop files here. Files that don't match the SKILL.md format are still added so you can fix them."
						action={
							<div className="flex flex-wrap items-center gap-2">
								<ImportSkillButton
									onImportFile={openFilePicker}
									onImportFolder={openFolderPicker}
									disabled={isUploading}
								/>
								<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
									<Plus size={14} className="mr-1" />
									Create skill
								</Button>
							</div>
						}
					/>
				</div>
			) : (
				<div className="space-y-2">
					{list.map((skill) => (
						<SkillRow
							key={skill.id}
							skill={skill}
							workspaceId={workspaceId}
							onEdit={() => setDialog({ kind: 'edit', name: skill.name })}
							onDelete={() => setDialog({ kind: 'delete', name: skill.name })}
						/>
					))}
				</div>
			)}

			{summary && (summary.imported > 0 || summary.failed.length > 0) && (
				<div className="mt-3 text-xs text-muted-foreground">
					{summary.imported > 0 && (
						<span>
							Imported {summary.imported} file{summary.imported === 1 ? '' : 's'}.
						</span>
					)}
					{summary.failed.length > 0 && (
						<span className="ml-1 text-error">
							{summary.failed.length} failed ({summary.failed[0]?.reason})
						</span>
					)}
				</div>
			)}

			<input
				ref={inputRef}
				type="file"
				accept={SKILL_UPLOAD_ACCEPT}
				multiple
				className="hidden"
				onChange={handleFileChange}
			/>
			<input
				ref={folderInputRef}
				type="file"
				// @ts-expect-error — webkitdirectory is a non-standard but universally
				// supported attribute (Chrome, Firefox, Safari, Edge) with no React/DOM
				// typing; it's not part of the `accept`-based file filtering above.
				webkitdirectory=""
				multiple
				className="hidden"
				onChange={handleFolderChange}
			/>

			{(dialog.kind === 'create' || dialog.kind === 'edit') && (
				<SkillDialog
					workspaceId={workspaceId}
					editingName={dialog.kind === 'edit' ? dialog.name : null}
					onClose={() => setDialog({ kind: 'closed' })}
				/>
			)}

			{dialog.kind === 'delete' && (
				<DeleteSkillDialog
					workspaceId={workspaceId}
					name={dialog.name}
					onClose={() => setDialog({ kind: 'closed' })}
				/>
			)}
		</div>
	)
}

function ImportSkillButton({
	onImportFile,
	onImportFolder,
	disabled,
}: {
	onImportFile: () => void
	onImportFolder: () => void
	disabled: boolean
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" disabled={disabled}>
					<FileUp size={14} className="mr-1" />
					Import
					<ChevronDown size={14} className="ml-1" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuItem onClick={onImportFile}>
					<FileUp size={14} className="mr-2" />
					From file
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onImportFolder}>
					<FolderUp size={14} className="mr-2" />
					From folder
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function SkillRow({
	skill,
	workspaceId,
	onEdit,
	onDelete,
}: {
	skill: WorkspaceSkillListItem
	workspaceId: string
	onEdit: () => void
	onDelete: () => void
}) {
	const [expanded, setExpanded] = useState(false)
	const replaceInputRef = useRef<HTMLInputElement>(null)
	const replaceFolderInputRef = useRef<HTMLInputElement>(null)
	const uploadMutation = useUploadWorkspaceSkill(workspaceId)
	const [downloading, setDownloading] = useState(false)
	const [downloadError, setDownloadError] = useState<string | null>(null)
	const [replaceError, setReplaceError] = useState<string | null>(null)

	const handleRowClick = () => {
		if (skill.isFolder) {
			setExpanded((v) => !v)
		} else {
			onEdit()
		}
	}

	const handleReplaceClick = (e: React.MouseEvent) => {
		e.stopPropagation()
		replaceInputRef.current?.click()
	}

	const handleReplaceFolderClick = (e: React.MouseEvent) => {
		e.stopPropagation()
		replaceFolderInputRef.current?.click()
	}

	const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		e.target.value = ''
		if (!file) return
		setReplaceError(null)
		try {
			await uploadMutation.mutateAsync({ file, skillId: skill.id })
		} catch (err) {
			setReplaceError(err instanceof Error ? err.message : 'Replace failed')
			// Row stays expanded so the user sees the error next to the controls.
		}
	}

	const handleReplaceFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files ? Array.from(e.target.files) : []
		e.target.value = ''
		if (files.length === 0) return
		setReplaceError(null)
		const result = await zipFolderFiles(files)
		if ('error' in result) {
			setReplaceError(result.error)
			return
		}
		try {
			await uploadMutation.mutateAsync({ file: result.file, skillId: skill.id })
		} catch (err) {
			setReplaceError(err instanceof Error ? err.message : 'Replace failed')
		}
	}

	const handleDownload = async (e: React.MouseEvent) => {
		e.stopPropagation()
		setDownloadError(null)
		setDownloading(true)
		try {
			const { blob, filename } = await api.workspaceSkills.download(workspaceId, skill.id)
			triggerBlobDownload(blob, filename)
		} catch (err) {
			setDownloadError(err instanceof Error ? err.message : 'Download failed')
		} finally {
			setDownloading(false)
		}
	}

	return (
		<div className="rounded-lg border border-border bg-card transition-colors hover:border-border-hover">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: row click supplements the inner kebab button, which keyboard users tab to and activate to reach Edit/Delete */}
			<div
				onClick={handleRowClick}
				className="flex items-center gap-3 p-4 cursor-pointer hover:bg-bg-hover rounded-lg"
			>
				{skill.isFolder && (
					<ChevronRight
						size={14}
						className={cn(
							'shrink-0 text-muted-foreground transition-transform',
							expanded && 'rotate-90',
						)}
						aria-hidden="true"
					/>
				)}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						{!skill.isValid && (
							<span
								className="shrink-0 text-warning"
								title="Invalid SKILL.md format — edit to fix"
								aria-label="Invalid SKILL.md format"
							>
								<AlertTriangle size={14} />
							</span>
						)}
						<p className="text-sm font-medium text-foreground truncate">{skill.name}</p>
						{skill.isFolder && (
							<span
								className="shrink-0 inline-flex items-center gap-1 rounded-md bg-bg-surface px-1.5 py-0.5 text-xs text-muted-foreground"
								title={`${skill.fileCount ?? 0} files in bundle`}
							>
								<Folder size={12} aria-hidden="true" />
								{skill.fileCount ?? 0} files
							</span>
						)}
					</div>
					{skill.description ? (
						<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
					) : !skill.isValid ? (
						<p className="text-xs text-warning truncate">
							{skill.isFolder
								? 'Missing SKILL.md at root — re-upload to fix'
								: "Won't be loaded by agents until the format is fixed"}
						</p>
					) : null}
				</div>
				<RelativeTime date={skill.updatedAt} className="text-xs text-muted-foreground shrink-0" />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="text-muted-foreground"
							aria-label={`Actions for ${skill.name}`}
							onClick={(e) => e.stopPropagation()}
						>
							<MoreHorizontal size={16} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
						<DropdownMenuItem onClick={onEdit}>
							<Pencil size={14} className="mr-2" />
							Edit
						</DropdownMenuItem>
						<DropdownMenuItem onClick={onDelete} className="text-error focus:text-error">
							<Trash2 size={14} className="mr-2" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{skill.isFolder && expanded && (
				<div className="border-t border-border px-4 py-3 space-y-3">
					<FolderFileTree
						workspaceId={workspaceId}
						skillId={skill.id}
						expectedCount={skill.fileCount ?? 0}
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleDownload}
							disabled={downloading || uploadMutation.isPending}
							aria-label={`Download ${skill.name} as zip`}
						>
							<Download size={14} className="mr-1" />
							{downloading ? 'Preparing...' : 'Download .zip'}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleReplaceClick}
							disabled={uploadMutation.isPending}
							aria-label={`Replace bundle for ${skill.name}`}
						>
							<RefreshCw size={14} className="mr-1" />
							{uploadMutation.isPending ? 'Uploading...' : 'Replace bundle'}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={handleReplaceFolderClick}
							disabled={uploadMutation.isPending}
							aria-label={`Replace bundle for ${skill.name} with a folder`}
						>
							<FolderUp size={14} className="mr-1" />
							{uploadMutation.isPending ? 'Uploading...' : 'Replace with folder'}
						</Button>
						<input
							ref={replaceInputRef}
							type="file"
							accept=".zip,application/zip,application/x-zip-compressed"
							className="hidden"
							onChange={handleReplaceFile}
						/>
						<input
							ref={replaceFolderInputRef}
							type="file"
							// @ts-expect-error — webkitdirectory has no React/DOM typing; see the
							// page-level folder input above for the same suppression.
							webkitdirectory=""
							multiple
							className="hidden"
							onChange={handleReplaceFolder}
						/>
					</div>
					{downloadError && <p className="text-xs text-error">{downloadError}</p>}
					{replaceError && <p className="text-xs text-error">{replaceError}</p>}
				</div>
			)}
		</div>
	)
}

function FolderFileTree({
	workspaceId,
	skillId,
	expectedCount,
}: {
	workspaceId: string
	skillId: string
	expectedCount: number
}) {
	const { data, isLoading, error } = useWorkspaceSkillFiles(workspaceId, skillId, true)

	if (isLoading) {
		return (
			<p className="text-xs text-muted-foreground">
				Loading {expectedCount} file{expectedCount === 1 ? '' : 's'}...
			</p>
		)
	}
	if (error) {
		return (
			<p className="text-xs text-error">
				{error instanceof Error ? error.message : 'Failed to load files'}
			</p>
		)
	}
	if (!data || data.length === 0) {
		return <p className="text-xs text-muted-foreground">No files in this bundle.</p>
	}

	return (
		<ul className="space-y-1" aria-label="Bundle files">
			{data.map((file) => (
				<li key={file.relativePath} className="flex items-center justify-between gap-2 font-mono">
					<span className="text-foreground text-xs truncate">{file.relativePath}</span>
					<span className="text-muted-foreground text-xs shrink-0">
						{formatSize(file.sizeBytes)}
					</span>
				</li>
			))}
		</ul>
	)
}

function SkillDialog({
	workspaceId,
	editingName,
	onClose,
}: {
	workspaceId: string
	editingName: string | null
	onClose: () => void
}) {
	const isEdit = editingName !== null
	const existing = useWorkspaceSkill(workspaceId, editingName)
	const createMutation = useCreateWorkspaceSkill(workspaceId)
	const updateMutation = useUpdateWorkspaceSkill(workspaceId)

	const [name, setName] = useState(editingName ?? '')
	const [content, setContent] = useState(isEdit ? '' : SKILL_TEMPLATE)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (existing.data) {
			setContent(existing.data.content)
		}
	}, [existing.data])

	const pending = createMutation.isPending || updateMutation.isPending
	const loadingExisting = isEdit && existing.isLoading
	const canSave =
		!pending && !loadingExisting && name.trim().length > 0 && content.trim().length > 0

	const handleSave = () => {
		setError(null)
		const trimmedName = name.trim()

		const nameResult = skillNameSchema.safeParse(trimmedName)
		if (!nameResult.success) {
			setError(nameResult.error.issues[0]?.message ?? 'Invalid skill name')
			return
		}

		const onError = (err: unknown) => {
			if (err instanceof ApiError) {
				setError(err.message)
			} else if (err instanceof Error) {
				setError(err.message)
			} else {
				setError('Failed to save skill')
			}
		}

		if (isEdit && editingName) {
			const renamed = trimmedName !== editingName
			updateMutation.mutate(
				{
					name: editingName,
					data: renamed ? { name: trimmedName, content } : { content },
					newName: renamed ? trimmedName : undefined,
				},
				{ onSuccess: () => onClose(), onError },
			)
		} else {
			createMutation.mutate({ name: trimmedName, content }, { onSuccess: () => onClose(), onError })
		}
	}

	return (
		<ResponsiveDialog open onOpenChange={(v) => !v && onClose()}>
			<ResponsiveDialogContent className="sm:max-w-2xl">
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>{isEdit ? 'Edit skill' : 'Create skill'}</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Skills are shared across this workspace. Agents only receive the skills attached to
						them.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="space-y-3 flex-1 min-h-0 overflow-y-auto">
					<div>
						<Label htmlFor="skill-name">Name</Label>
						<Input
							id="skill-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. deploy, review-pr"
							autoFocus={!isEdit}
						/>
					</div>
					<div>
						<Label htmlFor="skill-content">SKILL.md</Label>
						<Textarea
							id="skill-content"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							placeholder={SKILL_TEMPLATE}
							className="min-h-[280px] font-mono text-sm"
							disabled={loadingExisting}
						/>
						{isEdit && (
							<p className="mt-1 text-xs text-text-secondary">
								Only recognised frontmatter keys (name, description, and SKILL.md options) are
								preserved on save — custom keys are dropped.
							</p>
						)}
					</div>
					<FormError error={error ?? undefined} />
				</div>

				<ResponsiveDialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={!canSave}>
						{pending ? 'Saving...' : 'Save'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function DeleteSkillDialog({
	workspaceId,
	name,
	onClose,
}: {
	workspaceId: string
	name: string
	onClose: () => void
}) {
	const deleteMutation = useDeleteWorkspaceSkill(workspaceId)
	const [error, setError] = useState<string | null>(null)

	const handleDelete = () => {
		setError(null)
		deleteMutation.mutate(name, {
			onSuccess: () => onClose(),
			onError: (err) => {
				if (err instanceof ApiError) setError(err.message)
				else if (err instanceof Error) setError(err.message)
				else setError('Failed to delete skill')
			},
		})
	}

	return (
		<Dialog open onOpenChange={(v) => !v && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete skill</DialogTitle>
					<DialogDescription>
						Delete <span className="font-mono text-foreground">{name}</span>? This will detach it
						from any agents that currently use it.
					</DialogDescription>
				</DialogHeader>
				<FormError error={error ?? undefined} />
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={deleteMutation.isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
						{deleteMutation.isPending ? 'Deleting...' : 'Delete'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function sortSkills(
	skills: WorkspaceSkillListItem[],
	sort: SkillSort,
	order: SkillOrder,
): WorkspaceSkillListItem[] {
	const dir = order === 'asc' ? 1 : -1
	return [...skills].sort((a, b) => {
		if (sort === 'name') {
			return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir
		}
		// createdAt / updatedAt are ISO strings — lexicographic compare matches chronological order.
		const av = a[sort]
		const bv = b[sort]
		if (av === bv) return 0
		return (av < bv ? -1 : 1) * dir
	})
}

export function toSkillUpload(
	text: string,
	fileName: string,
): { baseName: string; content: string } {
	try {
		const parsed = parseSkillMd(text)
		if (skillNameSchema.safeParse(parsed.name).success) {
			return { baseName: parsed.name, content: text }
		}
	} catch {
		// Fall through to filename-derived name.
	}
	return { baseName: deriveNameFromFileName(fileName), content: text }
}

export function deriveNameFromFileName(fileName: string): string {
	const withoutExt = fileName.replace(/\.(md|markdown)$/i, '')
	const sanitised = withoutExt
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return sanitised.length > 0 ? sanitised : 'imported-skill'
}

export function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`.slice(0, 64)
		if (!taken.has(candidate)) return candidate
	}
	return `${base}-${Date.now()}`.slice(0, 64)
}

// FileReader rather than File.prototype.arrayBuffer()/.text() — the older
// callback API has the widest support across browsers and DOM
// implementations (notably, jsdom's Blob/File implementation doesn't
// implement the newer promise-returning methods at all).
function readFileAsUint8Array(file: File): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
		reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
		reader.readAsArrayBuffer(file)
	})
}

// Zips a `webkitdirectory`-selected FileList into a single .zip File, using
// each file's folder-relative path as its zip entry name. The server already
// strips a single top-level wrapper directory (see extractSkillBundle), so
// zipping the files exactly as `webkitRelativePath` reports them — root
// folder name included — lands as a valid wrapped bundle.
export async function zipFolderFiles(files: File[]): Promise<{ file: File } | { error: string }> {
	const nonEmpty = files.filter((f) => f.size > 0)
	if (nonEmpty.length === 0) return { error: 'Folder is empty' }
	if (nonEmpty.length > FOLDER_MAX_ENTRIES) {
		return { error: `Folder has ${nonEmpty.length} files (limit ${FOLDER_MAX_ENTRIES})` }
	}

	const entries: Record<string, Uint8Array> = {}
	let totalBytes = 0
	for (const file of nonEmpty) {
		const path = file.webkitRelativePath || file.name
		if (file.size > FOLDER_MAX_ENTRY_BYTES) {
			return {
				error: `${path} is ${formatSize(file.size)} (limit ${formatSize(FOLDER_MAX_ENTRY_BYTES)})`,
			}
		}
		totalBytes += file.size
		if (totalBytes > FOLDER_MAX_UNCOMPRESSED_BYTES) {
			return { error: `Folder exceeds ${formatSize(FOLDER_MAX_UNCOMPRESSED_BYTES)} uncompressed` }
		}
		entries[path] = await readFileAsUint8Array(file)
	}

	const rootName = (nonEmpty[0].webkitRelativePath || nonEmpty[0].name).split('/')[0] || 'skill'
	const zipped = zipSync(entries)
	return { file: new File([zipped], `${rootName}.zip`, { type: 'application/zip' }) }
}

export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—'
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)
}
