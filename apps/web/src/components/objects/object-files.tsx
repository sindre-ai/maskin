import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { useCreateFile, useFiles } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import type { RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatSize, readFileAsBase64 } from '@/lib/file-utils'
import { Loader2, Plus, SlidersHorizontal, Upload } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const ATTACHED_REL_TYPE = 'attached'

type ToggleableColumn = 'created_at' | 'modified_at'

const TOGGLEABLE_COLUMNS: { id: ToggleableColumn; label: string }[] = [
	{ id: 'created_at', label: 'Created' },
	{ id: 'modified_at', label: 'Modified' },
]

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
	// Collect endpoint ids from `attached` relationships in either direction,
	// then let `useFiles` resolve them against the `files` table. We deliberately
	// do NOT filter by `sourceType`/`targetType === 'file'`: some legacy edges
	// were written with a specialised label (e.g. `'bet'`, `'insight'`) even when
	// the endpoint is a file, and the label-based filter would silently drop the
	// attachment. `type === 'attached'` is the semantic file-attach type; the
	// `files.list` query returns only rows that actually live in `files`, so
	// non-file endpoints self-filter out.
	const candidateFileIds = useMemo(() => {
		if (!relationships) return [] as string[]
		const ids = new Set<string>()
		for (const rel of relationships.asSource) {
			if (rel.type !== 'attached') continue
			if (rel.targetId !== objectId) ids.add(rel.targetId)
			if (rel.sourceId !== objectId) ids.add(rel.sourceId)
		}
		for (const rel of relationships.asTarget) {
			if (rel.type !== 'attached') continue
			if (rel.sourceId !== objectId) ids.add(rel.sourceId)
			if (rel.targetId !== objectId) ids.add(rel.targetId)
		}
		return [...ids]
	}, [relationships, objectId])

	const { data: files = [] } = useFiles(workspaceId, { ids: candidateFileIds })

	const createFile = useCreateFile(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, objectId)

	const inputRef = useRef<HTMLInputElement>(null)
	const [isDragging, setIsDragging] = useState(false)
	const [isUploading, setIsUploading] = useState(false)
	const [visibleColumns, setVisibleColumns] = useState<Record<ToggleableColumn, boolean>>({
		created_at: false,
		modified_at: false,
	})

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

	const toggleColumn = useCallback((id: ToggleableColumn, visible: boolean) => {
		setVisibleColumns((prev) => ({ ...prev, [id]: visible }))
	}, [])

	const hasFiles = files.length > 0
	const totalCount = files.length

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
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8"
							title="File properties"
							aria-label="File properties"
						>
							<SlidersHorizontal size={14} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
							Properties
						</DropdownMenuLabel>
						{TOGGLEABLE_COLUMNS.map((col) => (
							<DropdownMenuCheckboxItem
								key={col.id}
								checked={visibleColumns[col.id]}
								onCheckedChange={(checked) => toggleColumn(col.id, checked === true)}
							>
								{col.label}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
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
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="h-8 px-2 text-xs">Name</TableHead>
							<TableHead className="h-8 px-2 text-xs w-24 text-right">Size</TableHead>
							{visibleColumns.created_at && (
								<TableHead className="h-8 px-2 text-xs w-28">Created</TableHead>
							)}
							{visibleColumns.modified_at && (
								<TableHead className="h-8 px-2 text-xs w-28">Modified</TableHead>
							)}
						</TableRow>
					</TableHeader>
					<TableBody>
						{files.map((file) => (
							<TableRow key={file.id}>
								<TableCell className="p-1">
									<AttachedFileCard
										workspaceId={workspaceId}
										file={file}
										className="border-0 bg-transparent px-2 py-1"
									/>
								</TableCell>
								<TableCell className="px-2 py-1 text-right text-xs text-muted-foreground font-mono">
									{formatSize(file.sizeBytes)}
								</TableCell>
								{visibleColumns.created_at && (
									<TableCell className="px-2 py-1 text-xs text-muted-foreground">
										<RelativeTime date={file.createdAt} />
									</TableCell>
								)}
								{visibleColumns.modified_at && (
									<TableCell className="px-2 py-1 text-xs text-muted-foreground">
										<RelativeTime date={file.updatedAt} />
									</TableCell>
								)}
							</TableRow>
						))}
					</TableBody>
				</Table>
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
