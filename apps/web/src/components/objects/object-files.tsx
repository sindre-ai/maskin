import { Button } from '@/components/ui/button'
import { useCreateFile, useFiles } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import type { FileListItem, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { File as FileIcon, Loader2, Plus, Upload } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const ATTACHED_REL_TYPE = 'attached'

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			const result = reader.result
			if (typeof result !== 'string') {
				reject(new Error('Failed to read file'))
				return
			}
			const comma = result.indexOf(',')
			resolve(comma >= 0 ? result.slice(comma + 1) : result)
		}
		reader.onerror = () => reject(new Error('Failed to read file'))
		reader.readAsDataURL(file)
	})
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

	const { data: workspaceFiles } = useFiles(workspaceId)
	const files = useMemo(() => {
		if (!workspaceFiles || fileIds.length === 0) return [] as FileListItem[]
		const lookup = new Map(workspaceFiles.map((f) => [f.id, f] as const))
		const result: FileListItem[] = []
		for (const id of fileIds) {
			const file = lookup.get(id)
			if (file) result.push(file)
		}
		return result
	}, [workspaceFiles, fileIds])

	const createFile = useCreateFile(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, objectId)

	const inputRef = useRef<HTMLInputElement>(null)
	const [isDragging, setIsDragging] = useState(false)
	const [isUploading, setIsUploading] = useState(false)

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
				<ul className="space-y-1">
					{files.map((file) => (
						<li key={file.id}>
							<Link
								to="/$workspaceId/files/$fileId"
								params={{ workspaceId, fileId: file.id }}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-bg-hover transition-colors"
							>
								<FileIcon size={14} className="text-muted-foreground shrink-0" />
								<span className="flex-1 truncate">{file.name}</span>
								<span className="text-xs text-muted-foreground font-mono">
									{formatSize(file.sizeBytes)}
								</span>
							</Link>
						</li>
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
