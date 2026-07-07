import { AttachedFileCard } from '@/components/shared/attached-file-card'
import { Button } from '@/components/ui/button'
import { useCreateFile, useFiles } from '@/hooks/use-files'
import { useCreateRelationship } from '@/hooks/use-relationships'
import type { RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { readFileAsBase64 } from '@/lib/file-utils'
import { Loader2, Plus, Upload } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

const ATTACHED_REL_TYPE = 'attached'

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
							<AttachedFileCard workspaceId={workspaceId} file={file} />
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
