import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { useActors } from '@/hooks/use-actors'
import { useCreateFile, useFiles } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { trackEvent } from '@/lib/analytics'
import type { FileListItem, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatSize, readFileAsBase64 } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import { Check, Columns3, File as FileIcon, Loader2, Plus, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const ATTACHED_REL_TYPE = 'attached'

// Scope value the per-actor display-settings store is keyed by for the files
// table. Distinct from any real `object.type`; the route's `objectTypeSchema`
// (/^[a-z][a-z0-9_]*$/) accepts it as a scope name.
const FILES_SETTINGS_SCOPE = 'files'

type ToggleableProperty = 'size' | 'created_at' | 'modified_at' | 'kind' | 'uploaded_by'

const TOGGLEABLE_PROPERTIES: { id: ToggleableProperty; label: string }[] = [
	{ id: 'size', label: 'Size' },
	{ id: 'created_at', label: 'Created' },
	{ id: 'modified_at', label: 'Modified' },
	{ id: 'kind', label: 'Kind' },
	{ id: 'uploaded_by', label: 'Uploaded by' },
]

// Per T1's design: Filename is locked-on. Size defaults ON; everything else
// defaults OFF — only non-default toggles count toward the bet's PostHog ship
// metric, so any default-ON property is invisible to the measurement.
const DEFAULT_VISIBLE: Record<ToggleableProperty, boolean> = {
	size: true,
	created_at: false,
	modified_at: false,
	kind: false,
	uploaded_by: false,
}

function deriveKind(file: Pick<FileListItem, 'name' | 'mimeType'>): string {
	const mime = file.mimeType?.toLowerCase() ?? ''
	if (mime.startsWith('image/')) return 'Image'
	if (mime === 'application/pdf') return 'PDF'
	if (mime === 'text/markdown') return 'Markdown'
	if (mime === 'text/html') return 'HTML'
	if (mime === 'text/csv') return 'CSV'
	if (mime === 'application/json') return 'JSON'
	const ext = file.name.split('.').pop()
	return ext && ext !== file.name ? ext.toUpperCase() : 'File'
}

interface ObjectFilesProps {
	workspaceId: string
	objectId: string
	objectType: string
	relationships?: { asSource: RelationshipResponse[]; asTarget: RelationshipResponse[] }
}

export function ObjectFiles({
	workspaceId,
	objectId,
	objectType,
	relationships,
}: ObjectFilesProps) {
	const fileIds = useMemo(() => {
		if (!relationships) return [] as string[]
		const ids = new Set<string>()
		for (const rel of relationships.asSource) {
			if (rel.targetType === 'file') ids.add(rel.targetId)
		}
		for (const rel of relationships.asTarget) {
			if (rel.sourceType === 'file') ids.add(rel.sourceId)
		}
		return [...ids]
	}, [relationships])

	const { data: files = [] } = useFiles(workspaceId, { ids: fileIds })

	const createFile = useCreateFile(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, objectId)

	const inputRef = useRef<HTMLInputElement>(null)
	const [isDragging, setIsDragging] = useState(false)
	const [isUploading, setIsUploading] = useState(false)
	const [visible, setVisible] = useState<Record<ToggleableProperty, boolean>>(DEFAULT_VISIBLE)

	// Per-actor visibility persistence under `object_type = "files"`. Reuses the
	// display-settings store from PR #486; `columnVisibility` is the only field
	// we write here.
	const displaySettingsQuery = useUserDisplaySettings(workspaceId, FILES_SETTINGS_SCOPE)
	const updateDisplaySettings = useUpdateUserDisplaySettings(workspaceId)
	// Pinning the stable mutate fn into a ref keeps the write-through effect's
	// deps from churning on every render — same trick the objects page uses to
	// avoid a write-every-debounce-cycle loop.
	const updateMutateRef = useRef(updateDisplaySettings.mutate)
	updateMutateRef.current = updateDisplaySettings.mutate
	const hydratedRef = useRef(false)

	useEffect(() => {
		if (hydratedRef.current) return
		if (!displaySettingsQuery.isSuccess) return
		hydratedRef.current = true
		const persisted = displaySettingsQuery.data
		const vis = persisted?.settings.columnVisibility
		if (!vis) return
		// Apply only the keys we own; fall back to current state for any property
		// not in the persisted blob so older saves (which only had created_at /
		// modified_at) still rehydrate cleanly without zeroing the new keys.
		setVisible((prev) => ({
			size: vis.size ?? prev.size,
			created_at: vis.created_at ?? prev.created_at,
			modified_at: vis.modified_at ?? prev.modified_at,
			kind: vis.kind ?? prev.kind,
			uploaded_by: vis.uploaded_by ?? prev.uploaded_by,
		}))
	}, [displaySettingsQuery.isSuccess, displaySettingsQuery.data])

	useEffect(() => {
		if (!hydratedRef.current) return
		const handle = setTimeout(() => {
			updateMutateRef.current({
				objectType: FILES_SETTINGS_SCOPE,
				settings: { columnVisibility: visible },
			})
		}, 500)
		return () => clearTimeout(handle)
	}, [visible])

	const handleUpload = useCallback(
		async (incoming: File[]) => {
			setIsUploading(true)
			try {
				for (const file of incoming) {
					const content = await readFileAsBase64(file)
					const created = await createFile.mutateAsync({
						name: file.name,
						mime_type: file.type || 'application/octet-stream',
						content,
						encoding: 'base64',
					})
					await createRelationship.mutateAsync({
						source_type: objectType,
						source_id: objectId,
						target_type: 'file',
						target_id: created.id,
						type: ATTACHED_REL_TYPE,
					})
					toast.success(`Uploaded ${file.name}`)
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to upload file')
			} finally {
				setIsUploading(false)
			}
		},
		[createFile, createRelationship, objectId, objectType],
	)

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const picked = e.target.files
			if (picked?.length) handleUpload(Array.from(picked))
			e.target.value = ''
		},
		[handleUpload],
	)

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(false)
			const dropped = e.dataTransfer.files
			if (dropped?.length) handleUpload(Array.from(dropped))
		},
		[handleUpload],
	)

	const toggleProperty = useCallback((id: ToggleableProperty, next: boolean) => {
		setVisible((prev) => ({ ...prev, [id]: next }))
		trackEvent('files_display_property_toggled', { property: id, enabled: next })
	}, [])

	const resetDefaults = useCallback(() => {
		setVisible(DEFAULT_VISIBLE)
	}, [])

	// Active = any toggleable property differs from its default. Powers the dot
	// indicator on the trigger so the operator can tell at a glance whether the
	// current view is the stock one.
	const hasActiveOverrides = useMemo(
		() => TOGGLEABLE_PROPERTIES.some(({ id }) => visible[id] !== DEFAULT_VISIBLE[id]),
		[visible],
	)

	// Resolve uploader actor IDs to display names. Only fetched while the column
	// is on so we don't churn the actors query for an off-by-default property.
	const actorsQuery = useActors(workspaceId, { enabled: visible.uploaded_by })
	const actorNameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const a of actorsQuery.data ?? []) map.set(a.id, a.name)
		return map
	}, [actorsQuery.data])

	const hasFiles = files.length > 0
	const totalCount = fileIds.length

	return (
		<div
			onDragOver={(e) => {
				e.preventDefault()
				if (!isDragging) setIsDragging(true)
			}}
			onDragLeave={() => setIsDragging(false)}
			onDrop={handleDrop}
			className={cn('rounded-md transition-colors', isDragging && 'bg-accent/5')}
		>
			<div className="flex items-center gap-2 mb-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Files ({totalCount})
				</h3>
				<div className="flex-1" />
				<ResponsivePopover>
					<ResponsivePopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 relative"
							title="File properties"
							aria-label="File properties"
						>
							<Columns3 size={14} />
							{hasActiveOverrides && (
								<span
									aria-hidden="true"
									className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary"
								/>
							)}
						</Button>
					</ResponsivePopoverTrigger>
					<ResponsivePopoverContent
						align="end"
						accessibleTitle="File properties"
						className="w-60 p-0"
					>
						<div className="px-3 pt-2.5 pb-1.5">
							<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
								Show properties
							</span>
						</div>
						<div className="flex flex-col gap-px p-1" role="menu">
							<MenuRow checked label="Filename" hint="Always" locked />
							{TOGGLEABLE_PROPERTIES.map((prop) => (
								<MenuRow
									key={prop.id}
									checked={visible[prop.id]}
									label={prop.label}
									onToggle={(next) => toggleProperty(prop.id, next)}
								/>
							))}
						</div>
						<div className="border-t border-border mt-1 p-1.5">
							<button
								type="button"
								onClick={resetDefaults}
								className="rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							>
								Reset to defaults
							</button>
						</div>
					</ResponsivePopoverContent>
				</ResponsivePopover>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					title="Attach file"
					aria-label="Attach file"
					onClick={() => inputRef.current?.click()}
					disabled={isUploading}
				>
					{isUploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
				</Button>
			</div>

			<input ref={inputRef} type="file" multiple className="hidden" onChange={handleFileChange} />

			{hasFiles ? (
				<ul className="flex flex-col gap-1 m-0 p-0 list-none">
					{files.map((file) => (
						<FileRow
							key={file.id}
							workspaceId={workspaceId}
							file={file}
							visible={visible}
							uploaderName={actorNameById.get(file.createdBy)}
						/>
					))}
				</ul>
			) : (
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					disabled={isUploading}
					className={cn(
						'w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:border-border-hover hover:text-foreground transition-colors',
						isDragging && 'border-accent text-accent',
						isUploading && 'pointer-events-none opacity-60',
					)}
				>
					<Upload size={14} />
					{isUploading ? 'Uploading…' : 'Drop a file here or click to upload'}
				</button>
			)}
		</div>
	)
}

interface MenuRowProps {
	checked: boolean
	label: string
	hint?: string
	locked?: boolean
	onToggle?: (next: boolean) => void
}

function MenuRow({ checked, label, hint, locked, onToggle }: MenuRowProps) {
	const interactive = !locked && onToggle
	return (
		<button
			type="button"
			role="menuitemcheckbox"
			aria-checked={checked}
			aria-disabled={locked ? true : undefined}
			onClick={interactive ? () => onToggle(!checked) : undefined}
			className={cn(
				'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left min-h-8 transition-colors',
				interactive ? 'hover:bg-accent cursor-pointer' : 'cursor-default opacity-90',
			)}
		>
			<span
				className={cn(
					'inline-flex h-3.5 w-3.5 items-center justify-center shrink-0',
					checked ? 'text-foreground' : 'text-muted-foreground',
				)}
			>
				{checked ? <Check size={14} /> : null}
			</span>
			<span className="flex-1">{label}</span>
			{hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
		</button>
	)
}

interface FileRowProps {
	workspaceId: string
	file: FileListItem
	visible: Record<ToggleableProperty, boolean>
	uploaderName: string | undefined
}

function FileRow({ workspaceId, file, visible, uploaderName }: FileRowProps) {
	const metaCells: { key: ToggleableProperty; node: React.ReactNode }[] = []
	if (visible.size) {
		metaCells.push({
			key: 'size',
			node: (
				<span className="font-mono tabular-nums whitespace-nowrap">
					{formatSize(file.sizeBytes)}
				</span>
			),
		})
	}
	if (visible.created_at) {
		metaCells.push({
			key: 'created_at',
			node: (
				<span className="tabular-nums whitespace-nowrap">
					Created <RelativeTime date={file.createdAt} />
				</span>
			),
		})
	}
	if (visible.modified_at) {
		metaCells.push({
			key: 'modified_at',
			node: (
				<span className="tabular-nums whitespace-nowrap">
					Modified <RelativeTime date={file.updatedAt} />
				</span>
			),
		})
	}
	if (visible.kind) {
		metaCells.push({
			key: 'kind',
			node: <span className="whitespace-nowrap">{deriveKind(file)}</span>,
		})
	}
	if (visible.uploaded_by) {
		metaCells.push({
			key: 'uploaded_by',
			node: <span className="whitespace-nowrap">{uploaderName ?? '—'}</span>,
		})
	}

	return (
		<li>
			<Link
				to="/$workspaceId/files/$fileId"
				params={{ workspaceId, fileId: file.id }}
				target="_blank"
				rel="noopener noreferrer"
				className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-bg-hover"
			>
				<FileIcon size={14} className="text-muted-foreground shrink-0" />
				<span className="flex-1 min-w-0 truncate">{file.name}</span>
				{metaCells.length > 0 && (
					<span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
						{metaCells.map((cell, i) => (
							<span key={cell.key} className="inline-flex items-center gap-1.5">
								{i > 0 && (
									<span aria-hidden="true" className="opacity-50">
										·
									</span>
								)}
								{cell.node}
							</span>
						))}
					</span>
				)}
			</Link>
		</li>
	)
}
