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
import type {
	ColumnMappingInput,
	ImportMappingInput,
	ImportResponse,
	RelationshipMappingInput,
	TypeMappingInput,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ChevronDown, ChevronRight, FileUp, Link2, Loader2, Plus, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Step = 'upload' | 'mapping'

interface ImportDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onImportStarted?: (importId: string) => void
}

export function ImportDialog({ open, onOpenChange, onImportStarted }: ImportDialogProps) {
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
		await confirmImport.mutateAsync(importId)
		onImportStarted?.(importId)
		onOpenChange(false)
	}, [importId, confirmImport, onImportStarted, onOpenChange])

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
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Import Objects</DialogTitle>
					<DialogDescription>
						{step === 'upload' &&
							'Upload a CSV or JSON file to import objects into your workspace.'}
						{step === 'mapping' && 'Review and adjust how columns map to object fields.'}
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
		display_names?: Record<string, string>
		relationship_types?: string[]
	}

	// Valid object types from workspace settings
	const validTypes = useMemo(() => {
		const statuses = settings.statuses ?? {}
		return Object.keys(statuses)
	}, [settings])

	const displayNames = settings.display_names ?? {}
	const relationshipTypes = settings.relationship_types ?? [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
	]

	// ── Local state for type mappings ─────────────────────────────────
	const [typeMappings, setTypeMappings] = useState<TypeMappingInput[]>(mapping?.typeMappings ?? [])

	// ── Local state for relationships ─────────────────────────────────
	const [localRelationships, setLocalRelationships] = useState<RelationshipMappingInput[]>(
		mapping?.relationships ?? [],
	)
	const [relSectionOpen, setRelSectionOpen] = useState((mapping?.relationships ?? []).length > 0)

	const isFirstRender = useRef(true)
	const lastSentMapping = useRef('')

	// Get target field options for a specific object type
	const getTargetOptions = useCallback(
		(objectType: string) => {
			const options = [
				{ value: 'title', label: 'Title' },
				{ value: 'content', label: 'Content' },
				{ value: 'status', label: 'Status' },
				{ value: 'owner', label: 'Owner' },
				{ value: '__skip__', label: 'Skip' },
			]

			const fieldDefs = settings.field_definitions ?? {}
			const typeDefs = fieldDefs[objectType]
			if (Array.isArray(typeDefs)) {
				for (const fd of typeDefs) {
					options.push({ value: `metadata.${fd.name}`, label: fd.name })
				}
			}

			return options
		},
		[settings],
	)

	const handleTargetChange = useCallback(
		(typeMappingIndex: number, sourceColumn: string, newTarget: string) => {
			setTypeMappings((prev) =>
				prev.map((tm, idx) =>
					idx === typeMappingIndex
						? {
								...tm,
								columns: tm.columns.map((col) =>
									col.sourceColumn === sourceColumn
										? {
												...col,
												targetField:
													newTarget === '__skip__' ? `metadata.${col.sourceColumn}` : newTarget,
												skip: newTarget === '__skip__',
											}
										: col,
								),
							}
						: tm,
				),
			)
		},
		[],
	)

	const handleTypeChange = useCallback(
		(typeMappingIndex: number, newType: string) => {
			setTypeMappings((prev) =>
				prev.map((tm, idx) =>
					idx === typeMappingIndex
						? {
								...tm,
								objectType: newType,
								defaultStatus: settings.statuses?.[newType]?.[0],
							}
						: tm,
				),
			)
		},
		[settings],
	)

	const handleAddType = useCallback(() => {
		if (!preview) return
		const usedTypes = new Set(typeMappings.map((tm) => tm.objectType))
		const newType = validTypes.find((t) => !usedTypes.has(t)) ?? validTypes[0] ?? ''
		const columns: ColumnMappingInput[] = preview.columns
			.filter((col: string) => col !== '')
			.map((col: string) => ({
				sourceColumn: col,
				targetField: `metadata.${normalize(col)}`,
				transform: 'none' as const,
				skip: true,
			}))
		setTypeMappings((prev) => [
			...prev,
			{
				objectType: newType,
				columns,
				defaultStatus: settings.statuses?.[newType]?.[0],
			},
		])
	}, [preview, typeMappings, validTypes, settings])

	const handleRemoveType = useCallback((index: number) => {
		setTypeMappings((prev) => prev.filter((_, i) => i !== index))
	}, [])

	// Build the full mapping object from local state
	const buildMapping = useCallback(
		(): ImportMappingInput => ({
			typeMappings,
			relationships: localRelationships,
		}),
		[typeMappings, localRelationships],
	)

	// Save mapping on changes (skip initial render, deduplicate identical updates)
	// biome-ignore lint/correctness/useExhaustiveDependencies: mapping is derived from buildMapping deps, adding it causes refetch loop
	useEffect(() => {
		if (!mapping) return
		if (isFirstRender.current) {
			isFirstRender.current = false
			return
		}
		const updated = buildMapping()
		const serialized = JSON.stringify(updated)
		if (serialized === lastSentMapping.current) return

		const timer = setTimeout(() => {
			lastSentMapping.current = serialized
			onMappingUpdate(updated)
		}, 500)
		return () => clearTimeout(timer)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excluding `mapping` to avoid refetch loop
	}, [buildMapping, onMappingUpdate])

	// Relationship handlers
	const configuredTypes = useMemo(() => typeMappings.map((tm) => tm.objectType), [typeMappings])

	const handleAddRelationship = useCallback(() => {
		const firstType = configuredTypes[0] ?? ''
		const secondType = configuredTypes[1] ?? configuredTypes[0] ?? ''
		const firstRelType = relationshipTypes.find((rt) => rt !== '') ?? 'relates_to'
		setLocalRelationships((prev) => [
			...prev,
			{
				sourceType: firstType,
				relationshipType: firstRelType,
				targetType: secondType,
			},
		])
		setRelSectionOpen(true)
	}, [configuredTypes, relationshipTypes])

	const handleUpdateRelationship = useCallback(
		(index: number, field: keyof RelationshipMappingInput, value: string) => {
			setLocalRelationships((prev) =>
				prev.map((rel, i) => (i === index ? { ...rel, [field]: value } : rel)),
			)
		},
		[],
	)

	const handleRemoveRelationship = useCallback((index: number) => {
		setLocalRelationships((prev) => prev.filter((_, i) => i !== index))
	}, [])

	if (!mapping || !preview) return null

	return (
		<div className="space-y-4">
			{/* Summary */}
			<div className="flex gap-4 text-sm">
				<div>
					<span className="text-muted-foreground">Rows:</span>{' '}
					<span className="font-medium">{preview.totalRows}</span>
				</div>
				<div>
					<span className="text-muted-foreground">File:</span>{' '}
					<span className="font-medium">{importRecord.fileName}</span>
				</div>
			</div>

			{/* Type mappings */}
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<span className="text-sm font-medium">Object Types</span>
					<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleAddType}>
						<Plus size={12} />
						Add type
					</Button>
				</div>

				{typeMappings.map((tm, tmIndex) => (
					<TypeMappingSection
						// biome-ignore lint/suspicious/noArrayIndexKey: type mappings have no stable ID
						key={tmIndex}
						typeMapping={tm}
						typeMappingIndex={tmIndex}
						validTypes={validTypes}
						displayNames={displayNames}
						targetOptions={getTargetOptions(tm.objectType)}
						sampleRows={preview.sampleRows}
						canRemove={typeMappings.length > 1}
						onTypeChange={handleTypeChange}
						onTargetChange={handleTargetChange}
						onRemove={handleRemoveType}
					/>
				))}
			</div>

			{/* Relationships section */}
			<div className="border rounded-lg">
				<div className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium">
					<button
						type="button"
						className="flex items-center gap-2 hover:text-accent transition-colors"
						onClick={() => setRelSectionOpen((prev) => !prev)}
					>
						{relSectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
						<Link2 size={14} />
						Relationships
						{localRelationships.length > 0 && (
							<span className="text-xs bg-muted px-1.5 py-0.5 rounded">
								{localRelationships.length}
							</span>
						)}
					</button>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={handleAddRelationship}
					>
						<Plus size={12} />
						Add
					</Button>
				</div>

				{relSectionOpen && localRelationships.length > 0 && (
					<div className="border-t px-3 py-2 space-y-2">
						{localRelationships.map((rel, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: relationships have no stable ID
							<div key={idx} className="flex items-center gap-2 text-sm">
								<Select
									value={rel.sourceType}
									onValueChange={(v) => handleUpdateRelationship(idx, 'sourceType', v)}
								>
									<SelectTrigger className="flex-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{configuredTypes
											.filter((t) => t !== '')
											.map((t) => (
												<SelectItem key={t} value={t}>
													{displayNames[t] ?? t}
												</SelectItem>
											))}
									</SelectContent>
								</Select>

								<Select
									value={rel.relationshipType}
									onValueChange={(v) => handleUpdateRelationship(idx, 'relationshipType', v)}
								>
									<SelectTrigger className="flex-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{relationshipTypes
											.filter((rt) => rt !== '')
											.map((rt) => (
												<SelectItem key={rt} value={rt}>
													{rt.replace(/_/g, ' ')}
												</SelectItem>
											))}
									</SelectContent>
								</Select>

								<Select
									value={rel.targetType}
									onValueChange={(v) => handleUpdateRelationship(idx, 'targetType', v)}
								>
									<SelectTrigger className="flex-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{configuredTypes
											.filter((t) => t !== '')
											.map((t) => (
												<SelectItem key={t} value={t}>
													{displayNames[t] ?? t}
												</SelectItem>
											))}
									</SelectContent>
								</Select>

								<Button
									variant="ghost"
									size="sm"
									className="h-7 w-7 p-0 shrink-0"
									onClick={() => handleRemoveRelationship(idx)}
								>
									<X size={14} />
								</Button>
							</div>
						))}
					</div>
				)}

				{relSectionOpen && localRelationships.length === 0 && (
					<div className="border-t px-3 py-4 text-center text-xs text-muted-foreground">
						No relationships configured. Click "Add" to link objects together.
					</div>
				)}
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
				<Button onClick={onConfirm}>
					Import {preview.totalRows} rows
					{typeMappings.length > 1 ? ` \u00d7 ${typeMappings.length} types` : ''}
					{localRelationships.length > 0 ? ' + relationships' : ''}
				</Button>
			</DialogFooter>
		</div>
	)
}

// ── Type Mapping Section ───────────────────────────────────────────────

function TypeMappingSection({
	typeMapping,
	typeMappingIndex,
	validTypes,
	displayNames,
	targetOptions,
	sampleRows,
	canRemove,
	onTypeChange,
	onTargetChange,
	onRemove,
}: {
	typeMapping: TypeMappingInput
	typeMappingIndex: number
	validTypes: string[]
	displayNames: Record<string, string>
	targetOptions: { value: string; label: string }[]
	sampleRows: Record<string, string>[]
	canRemove: boolean
	onTypeChange: (index: number, newType: string) => void
	onTargetChange: (typeMappingIndex: number, sourceColumn: string, newTarget: string) => void
	onRemove: (index: number) => void
}) {
	return (
		<div className="border rounded-lg overflow-hidden">
			{/* Type header */}
			<div className="flex items-center gap-2 px-3 py-2 bg-muted/50">
				<Select
					value={typeMapping.objectType}
					onValueChange={(v) => onTypeChange(typeMappingIndex, v)}
				>
					<SelectTrigger className="w-fit">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{validTypes
							.filter((t) => t !== '')
							.map((t) => (
								<SelectItem key={t} value={t}>
									{displayNames[t] ?? t}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
				{canRemove && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0 shrink-0 ml-auto"
						onClick={() => onRemove(typeMappingIndex)}
					>
						<X size={14} />
					</Button>
				)}
			</div>

			{/* Column mapping table */}
			<table className="w-full text-sm">
				<thead>
					<tr className="bg-muted/30">
						<th className="text-left px-3 py-2 font-medium">Source Column</th>
						<th className="text-left px-3 py-2 font-medium">Maps To</th>
						<th className="text-left px-3 py-2 font-medium">Sample</th>
					</tr>
				</thead>
				<tbody>
					{typeMapping.columns.map((col) => {
						const sampleValue = sampleRows[0]?.[col.sourceColumn] ?? ''
						return (
							<tr key={col.sourceColumn} className="border-t">
								<td className="px-3 py-2 font-mono text-xs">{col.sourceColumn}</td>
								<td className="px-3 py-2">
									<Select
										value={col.skip ? '__skip__' : col.targetField}
										onValueChange={(v) => onTargetChange(typeMappingIndex, col.sourceColumn, v)}
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
	)
}

// ── Helper ──────────────────────────────────────────────────────────────

function normalize(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/g, '_')
}
