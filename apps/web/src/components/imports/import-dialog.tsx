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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import {
	useConfirmImport,
	useCreateImport,
	useImport,
	useUpdateImportMapping,
} from '@/hooks/use-imports'
import type { ColumnMappingInput, ImportMappingInput, ImportResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { CheckCircle, FileUp, Loader2, Upload, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Step = 'upload' | 'mapping' | 'progress'

interface ImportDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
	const { workspaceId, workspace } = useWorkspace()
	const [step, setStep] = useState<Step>('upload')
	const [importId, setImportId] = useState<string | undefined>()

	const createImport = useCreateImport(workspaceId)
	const updateMapping = useUpdateImportMapping(workspaceId)
	const confirmImport = useConfirmImport(workspaceId)
	const { data: importData } = useImport(importId, workspaceId)

	const createImportReset = createImport.reset
	const confirmImportReset = confirmImport.reset

	// Reset on close
	useEffect(() => {
		if (!open) {
			setStep('upload')
			setImportId(undefined)
			createImportReset()
			confirmImportReset()
		}
	}, [open, createImportReset, confirmImportReset])

	const handleFileUpload = useCallback(
		async (file: File) => {
			const result = await createImport.mutateAsync(file)
			setImportId(result.id)
			setStep('mapping')
		},
		[createImport],
	)

	const handleConfirm = useCallback(async () => {
		if (!importId) return
		setStep('progress')
		await confirmImport.mutateAsync(importId)
	}, [importId, confirmImport])

	const handleMappingUpdate = useCallback(
		async (mapping: ImportMappingInput) => {
			if (!importId) return
			await updateMapping.mutateAsync({ id: importId, mapping })
		},
		[importId, updateMapping],
	)

	const importRecord = importData ?? createImport.data

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[80vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Import Objects</DialogTitle>
					<DialogDescription>
						{step === 'upload' &&
							'Upload a CSV or JSON file to import objects into your workspace.'}
						{step === 'mapping' && 'Review and adjust how columns map to object fields.'}
						{step === 'progress' && 'Importing objects...'}
					</DialogDescription>
				</DialogHeader>

				{step === 'upload' && (
					<UploadStep onFileUpload={handleFileUpload} isLoading={createImport.isPending} />
				)}

				{step === 'mapping' && importRecord && (
					<MappingStep
						importRecord={importRecord}
						workspace={workspace}
						onConfirm={handleConfirm}
						onMappingUpdate={handleMappingUpdate}
						isUpdating={updateMapping.isPending}
					/>
				)}

				{step === 'progress' && (
					<ProgressStep importRecord={importRecord} onClose={() => onOpenChange(false)} />
				)}
			</DialogContent>
		</Dialog>
	)
}

// ── Upload Step ─────────────────────────────────────────────────────────

function UploadStep({
	onFileUpload,
	isLoading,
}: {
	onFileUpload: (file: File) => void
	isLoading: boolean
}) {
	const [isDragging, setIsDragging] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(false)
			const file = e.dataTransfer.files[0]
			if (file) onFileUpload(file)
		},
		[onFileUpload],
	)

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0]
			if (file) onFileUpload(file)
		},
		[onFileUpload],
	)

	return (
		<div
			className={cn(
				'flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed p-8 transition-colors',
				isDragging ? 'border-accent bg-accent/5' : 'border-border',
				isLoading && 'pointer-events-none opacity-50',
			)}
			onDragOver={(e) => {
				e.preventDefault()
				setIsDragging(true)
			}}
			onDragLeave={() => setIsDragging(false)}
			onDrop={handleDrop}
		>
			{isLoading ? (
				<Loader2 size={32} className="animate-spin text-muted-foreground" />
			) : (
				<Upload size={32} className="text-muted-foreground" />
			)}
			<div className="text-center">
				<p className="text-sm font-medium">
					{isLoading ? 'Uploading and parsing...' : 'Drag and drop a file here'}
				</p>
				<p className="text-xs text-muted-foreground mt-1">Supports CSV and JSON files</p>
			</div>
			{!isLoading && (
				<Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
					<FileUp size={16} />
					Browse files
				</Button>
			)}
			<input
				ref={inputRef}
				type="file"
				accept=".csv,.json"
				className="hidden"
				onChange={handleFileChange}
			/>
		</div>
	)
}

// ── Mapping Step ────────────────────────────────────────────────────────

function MappingStep({
	importRecord,
	workspace,
	onConfirm,
	onMappingUpdate,
	isUpdating,
}: {
	importRecord: ImportResponse
	workspace: { settings: Record<string, unknown> }
	onConfirm: () => void
	onMappingUpdate: (mapping: ImportMappingInput) => void
	isUpdating: boolean
}) {
	const mapping = importRecord.mapping
	const preview = importRecord.preview
	const settings = workspace.settings as {
		statuses?: Record<string, string[]>
		field_definitions?: Record<string, { name: string; type: string }[]>
	}

	// Build list of available target fields
	const targetOptions = useMemo(() => {
		const options = [
			{ value: 'title', label: 'Title' },
			{ value: 'content', label: 'Content' },
			{ value: 'status', label: 'Status' },
			{ value: 'owner', label: 'Owner' },
			{ value: 'type', label: 'Type' },
			{ value: '__skip__', label: 'Skip' },
		]

		// Add metadata fields from all types
		const fieldDefs = settings.field_definitions ?? {}
		const seen = new Set<string>()
		for (const typeDefs of Object.values(fieldDefs)) {
			if (Array.isArray(typeDefs)) {
				for (const fd of typeDefs) {
					if (!seen.has(fd.name)) {
						options.push({ value: `metadata.${fd.name}`, label: fd.name })
						seen.add(fd.name)
					}
				}
			}
		}

		return options
	}, [settings])

	// Local mapping state for editing
	const [localColumns, setLocalColumns] = useState<ColumnMappingInput[]>(mapping?.columns ?? [])
	const isFirstRender = useRef(true)

	const handleTargetChange = useCallback((sourceColumn: string, newTarget: string) => {
		setLocalColumns((prev) =>
			prev.map((col) =>
				col.sourceColumn === sourceColumn
					? {
							...col,
							targetField: newTarget === '__skip__' ? `metadata.${col.sourceColumn}` : newTarget,
							skip: newTarget === '__skip__',
						}
					: col,
			),
		)
	}, [])

	// Save mapping on changes (skip initial render)
	useEffect(() => {
		if (!mapping) return
		if (isFirstRender.current) {
			isFirstRender.current = false
			return
		}
		const updated: ImportMappingInput = {
			...mapping,
			columns: localColumns,
		}
		const timer = setTimeout(() => onMappingUpdate(updated), 500)
		return () => clearTimeout(timer)
	}, [localColumns, mapping, onMappingUpdate])

	if (!mapping || !preview) return null

	const objectType =
		typeof mapping.objectType === 'string'
			? mapping.objectType
			: `Multiple (via "${mapping.objectType.column}" column)`

	return (
		<div className="space-y-4">
			{/* Summary */}
			<div className="flex gap-4 text-sm">
				<div>
					<span className="text-muted-foreground">Rows:</span>{' '}
					<span className="font-medium">{preview.totalRows}</span>
				</div>
				<div>
					<span className="text-muted-foreground">Type:</span>{' '}
					<span className="font-medium">{objectType}</span>
				</div>
				<div>
					<span className="text-muted-foreground">File:</span>{' '}
					<span className="font-medium">{importRecord.fileName}</span>
				</div>
			</div>

			{/* Column mapping table */}
			<div className="border rounded-lg overflow-x-auto">
				<table className="w-full text-sm min-w-[400px]">
					<thead>
						<tr className="bg-muted/50">
							<th className="text-left px-3 py-2 font-medium">Source Column</th>
							<th className="text-left px-3 py-2 font-medium">Maps To</th>
							<th className="text-left px-3 py-2 font-medium">Sample</th>
						</tr>
					</thead>
					<tbody>
						{localColumns.map((col) => {
							const sampleValue = preview.sampleRows[0]?.[col.sourceColumn] ?? ''
							return (
								<tr key={col.sourceColumn} className="border-t">
									<td className="px-3 py-2 font-mono text-xs">{col.sourceColumn}</td>
									<td className="px-3 py-2">
										<Select
											value={col.skip ? '__skip__' : col.targetField}
											onValueChange={(v) => handleTargetChange(col.sourceColumn, v)}
										>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{targetOptions.map((opt) => (
													<SelectItem key={opt.value} value={opt.value}>
														{opt.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</td>
									<td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[150px]">
										{sampleValue}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>

			<p
				aria-hidden={!isUpdating}
				className={cn(
					'text-xs flex items-center gap-1',
					isUpdating ? 'text-muted-foreground' : 'invisible',
				)}
			>
				<Loader2 size={12} className="animate-spin" /> Saving mapping...
			</p>

			<DialogFooter>
				<Button onClick={onConfirm}>Import {preview.totalRows} objects</Button>
			</DialogFooter>
		</div>
	)
}

// ── Progress Step ───────────────────────────────────────────────────────

function ProgressStep({
	importRecord,
	onClose,
}: {
	importRecord: ImportResponse | undefined
	onClose: () => void
}) {
	if (!importRecord) {
		return (
			<div className="flex items-center justify-center py-8">
				<Loader2 size={24} className="animate-spin text-muted-foreground" />
			</div>
		)
	}

	const { status, totalRows, processedRows, successCount, errorCount, errors } = importRecord
	const isComplete = status === 'completed' || status === 'failed'
	const progress = totalRows ? Math.round((processedRows / totalRows) * 100) : 0

	return (
		<div className="space-y-4">
			{/* Progress bar */}
			<div className="space-y-2">
				<div className="flex justify-between text-sm">
					<span className="text-muted-foreground">
						{isComplete ? 'Complete' : `Processing... ${processedRows}/${totalRows}`}
					</span>
					<span className="font-medium">{progress}%</span>
				</div>
				<div className="h-2 bg-muted rounded-full overflow-hidden">
					<div
						className={cn(
							'h-full rounded-full transition-all duration-300',
							status === 'failed' ? 'bg-destructive' : 'bg-accent',
						)}
						style={{ width: `${progress}%` }}
					/>
				</div>
			</div>

			{/* Results */}
			{isComplete && (
				<div className="space-y-3">
					<div className="flex gap-4 text-sm">
						{successCount > 0 && (
							<div className="flex items-center gap-1 text-green-600 dark:text-green-400">
								<CheckCircle size={14} />
								{successCount} created
							</div>
						)}
						{errorCount > 0 && (
							<div className="flex items-center gap-1 text-destructive">
								<XCircle size={14} />
								{errorCount} failed
							</div>
						)}
					</div>

					{/* Error details */}
					{errors && errors.length > 0 && (
						<div className="rounded border bg-muted/30 p-3 max-h-40 overflow-y-auto">
							<p className="text-xs font-medium mb-2">Errors:</p>
							{errors.slice(0, 20).map((err) => (
								<p key={`row-${err.row}`} className="text-xs text-muted-foreground">
									Row {err.row}: {err.message}
								</p>
							))}
							{errors.length > 20 && (
								<p className="text-xs text-muted-foreground mt-1">
									...and {errors.length - 20} more
								</p>
							)}
						</div>
					)}
				</div>
			)}

			{!isComplete && (
				<div className="flex items-center justify-center py-4">
					<Loader2 size={20} className="animate-spin text-muted-foreground" />
				</div>
			)}

			<DialogFooter>
				<Button variant={isComplete ? 'default' : 'outline'} onClick={onClose}>
					{isComplete ? 'Done' : 'Close'}
				</Button>
			</DialogFooter>
		</div>
	)
}
