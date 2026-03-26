import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { useUpdateObject } from '@/hooks/use-objects'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import type { ObjectResponse, WorkspaceWithRole } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import type { SafeJsonValue, SafeMetadata } from '@ai-native/shared'
import { X } from 'lucide-react'
import { useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export function MetadataPropertiesView({
	object,
	workspace,
	onUpdateMetadata,
	onRemoveMetadata,
	onCreateField,
}: {
	object: ObjectResponse
	workspace: WorkspaceWithRole
	onUpdateMetadata: (id: string, metadata: SafeMetadata) => void
	onRemoveMetadata: (id: string, key: string) => void
	onCreateField?: (
		workspace: WorkspaceWithRole,
		objectType: string,
		field: FieldDefinition,
		updatedSettings: Record<string, unknown>,
	) => void
}) {
	const [showAddMenu, setShowAddMenu] = useState(false)
	const [showCreateForm, setShowCreateForm] = useState(false)

	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined)?.[object.type] ??
		[]

	const metadata = object.metadata ?? {}
	const metaEntries = Object.entries(metadata).filter(([key]) => !key.startsWith('_'))

	// Fields defined but not yet set on this object
	const existingKeys = new Set(Object.keys(metadata))
	const unsetFields = fieldDefs.filter((f) => !existingKeys.has(f.name))

	const handleUpdate = (key: string, value: SafeJsonValue) => {
		onUpdateMetadata(object.id, { ...metadata, [key]: value })
	}

	const handleRemove = (key: string) => {
		onRemoveMetadata(object.id, key)
	}

	const handleAddField = (field: FieldDefinition) => {
		const defaultValue = getDefaultValue(field)
		handleUpdate(field.name, defaultValue)
		setShowAddMenu(false)
	}

	const handleFieldCreated = (field: FieldDefinition) => {
		const defaultValue = getDefaultValue(field)
		handleUpdate(field.name, defaultValue)
		setShowCreateForm(false)
		setShowAddMenu(false)
	}

	const handleSaveField = (field: FieldDefinition) => {
		if (!onCreateField) return

		const existingDefs =
			(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}
		const typeFields = existingDefs[object.type] ?? []

		if (typeFields.some((f) => f.name === field.name)) return

		const updatedDefs = {
			...existingDefs,
			[object.type]: [...typeFields, field],
		}

		onCreateField(workspace, object.type, field, {
			...settings,
			field_definitions: updatedDefs,
		})
	}

	if (metaEntries.length === 0 && unsetFields.length === 0 && !showAddMenu) {
		return (
			<Button variant="ghost" size="sm" onClick={() => setShowAddMenu(true)}>
				+ Add property
			</Button>
		)
	}

	return (
		<div className="space-y-1 w-fit">
			{metaEntries.map(([key, value]) => {
				const fieldDef = fieldDefs.find((f) => f.name === key)
				return (
					<PropertyRow
						key={key}
						name={key}
						value={value}
						fieldDef={fieldDef}
						onUpdate={(v) => handleUpdate(key, v)}
						onRemove={() => handleRemove(key)}
					/>
				)
			})}

			{/* Add property button / menu */}
			{showAddMenu ? (
				<AddPropertyMenu
					unsetFields={unsetFields}
					onSelectField={handleAddField}
					onCreateNew={() => setShowCreateForm(true)}
					onClose={() => {
						setShowAddMenu(false)
						setShowCreateForm(false)
					}}
					showCreateForm={showCreateForm}
					workspace={workspace}
					objectType={object.type}
					onFieldCreated={handleFieldCreated}
					onSaveField={onCreateField ? handleSaveField : undefined}
				/>
			) : (
				<Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAddMenu(true)}>
					+ Add property
				</Button>
			)}
		</div>
	)
}

export function MetadataProperties({ object }: { object: ObjectResponse }) {
	const { workspaceId, workspace } = useWorkspace()
	const updateObject = useUpdateObject(workspaceId)
	const updateWorkspace = useUpdateWorkspace(workspace.id)

	const handleUpdateMetadata = (id: string, metadata: SafeMetadata) => {
		updateObject.mutate({ id, data: { metadata } })
	}

	const handleRemoveMetadata = (id: string, key: string) => {
		const next = { ...object.metadata }
		delete next[key]
		updateObject.mutate({ id, data: { metadata: next } })
	}

	const handleCreateField = (
		_workspace: WorkspaceWithRole,
		_objectType: string,
		_field: FieldDefinition,
		updatedSettings: Record<string, unknown>,
	) => {
		updateWorkspace.mutate({ settings: updatedSettings })
	}

	return (
		<MetadataPropertiesView
			object={object}
			workspace={workspace}
			onUpdateMetadata={handleUpdateMetadata}
			onRemoveMetadata={handleRemoveMetadata}
			onCreateField={handleCreateField}
		/>
	)
}

function PropertyRow({
	name,
	value,
	fieldDef,
	onUpdate,
	onRemove,
}: {
	name: string
	value: SafeJsonValue
	fieldDef?: FieldDefinition
	onUpdate: (value: SafeJsonValue) => void
	onRemove: () => void
}) {
	const [editing, setEditing] = useState(false)
	const type = fieldDef?.type ?? inferType(value)

	return (
		<div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 group">
			<span className="w-28 shrink-0 text-xs text-muted-foreground truncate" title={name}>
				{name}
			</span>
			<div className="flex-1 min-w-0">
				{editing ? (
					<PropertyEditor
						type={type}
						value={value}
						fieldDef={fieldDef}
						onSave={(v) => {
							onUpdate(v)
							setEditing(false)
						}}
						onCancel={() => setEditing(false)}
					/>
				) : (
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground text-left truncate max-w-full"
						onClick={() => setEditing(true)}
					>
						{formatDisplay(value, type)}
					</button>
				)}
			</div>
			<Button
				variant="ghost"
				size="icon"
				className="text-muted-foreground hover:text-error opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
				onClick={onRemove}
				title="Remove property"
			>
				<X className="h-3 w-3" />
			</Button>
		</div>
	)
}

function PropertyEditor({
	type,
	value,
	fieldDef,
	onSave,
	onCancel,
}: {
	type: string
	value: SafeJsonValue
	fieldDef?: FieldDefinition
	onSave: (value: SafeJsonValue) => void
	onCancel: () => void
}) {
	const [draft, setDraft] = useState(String(value ?? ''))

	const inputClass = 'h-6 text-xs px-2 py-0.5'

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') handleSave()
		if (e.key === 'Escape') onCancel()
	}

	const handleSave = () => {
		switch (type) {
			case 'number': {
				const num = Number(draft)
				if (!Number.isNaN(num)) onSave(num)
				else onCancel()
				break
			}
			case 'boolean':
				onSave(draft === 'true')
				break
			case 'date':
				onSave(draft || null)
				break
			default:
				onSave(draft)
		}
	}

	switch (type) {
		case 'boolean':
			return (
				<Select
					defaultOpen
					value={draft}
					onValueChange={(v) => {
						setDraft(v)
						onSave(v === 'true')
					}}
					onOpenChange={(open) => {
						if (!open) onCancel()
					}}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">Yes</SelectItem>
						<SelectItem value="false">No</SelectItem>
					</SelectContent>
				</Select>
			)
		case 'date':
			return (
				<Input
					type="date"
					value={draft ? draft.slice(0, 10) : ''}
					onChange={(e) => {
						setDraft(e.target.value)
						onSave(e.target.value)
					}}
					className={`${inputClass} w-32`}
					autoFocus
					onBlur={onCancel}
				/>
			)
		case 'enum':
			return (
				<Select
					defaultOpen
					value={draft}
					onValueChange={(v) => {
						setDraft(v)
						onSave(v)
					}}
					onOpenChange={(open) => {
						if (!open) onCancel()
					}}
				>
					<SelectTrigger>
						<SelectValue placeholder="Select..." />
					</SelectTrigger>
					<SelectContent>
						{(fieldDef?.values ?? []).map((v) => (
							<SelectItem key={v} value={v}>
								{v}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)
		case 'number':
			return (
				<Input
					type="number"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={handleSave}
					onKeyDown={handleKeyDown}
					className={`${inputClass} w-24`}
					autoFocus
				/>
			)
		default:
			return (
				<Input
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={handleSave}
					onKeyDown={handleKeyDown}
					className={`${inputClass} w-full`}
					autoFocus
				/>
			)
	}
}

function AddPropertyMenu({
	unsetFields,
	onSelectField,
	onCreateNew,
	onClose,
	showCreateForm,
	workspace,
	objectType,
	onFieldCreated,
	onSaveField,
}: {
	unsetFields: FieldDefinition[]
	onSelectField: (field: FieldDefinition) => void
	onCreateNew: () => void
	onClose: () => void
	showCreateForm: boolean
	workspace: WorkspaceWithRole
	objectType: string
	onFieldCreated: (field: FieldDefinition) => void
	onSaveField?: (field: FieldDefinition) => void
}) {
	if (showCreateForm) {
		return (
			<CreateFieldForm
				workspace={workspace}
				objectType={objectType}
				onCreated={onFieldCreated}
				onCancel={onClose}
				onSaveField={onSaveField}
			/>
		)
	}

	return (
		<div className="rounded border border-border bg-card p-2 text-xs space-y-1 w-fit">
			{unsetFields.length > 0 && (
				<>
					<p className="text-muted-foreground px-1 text-[10px] uppercase tracking-wider">
						Defined fields
					</p>
					{unsetFields.map((field) => (
						<Button
							key={field.name}
							variant="ghost"
							className="justify-start"
							onClick={() => onSelectField(field)}
						>
							<FieldTypeIcon type={field.type} />
							<span>{field.name}</span>
							<span className="text-muted-foreground text-[10px]">({field.type})</span>
						</Button>
					))}
					<Separator className="my-1" />
				</>
			)}
			<Button variant="ghost" className="justify-start text-primary" onClick={onCreateNew}>
				+ Create new property
			</Button>
			<Button variant="ghost" size="sm" onClick={onClose}>
				Cancel
			</Button>
		</div>
	)
}

function CreateFieldForm({
	workspace,
	objectType,
	onCreated,
	onCancel,
	onSaveField,
}: {
	workspace: WorkspaceWithRole
	objectType: string
	onCreated: (field: FieldDefinition) => void
	onCancel: () => void
	onSaveField?: (field: FieldDefinition) => void
}) {
	const [name, setName] = useState('')
	const [type, setType] = useState<FieldDefinition['type']>('text')
	const [enumValues, setEnumValues] = useState('')
	const [isPending, setIsPending] = useState(false)

	const handleCreate = () => {
		const trimmedName = name.trim()
		if (!trimmedName) return

		const newField: FieldDefinition = {
			name: trimmedName,
			type,
			...(type === 'enum' && enumValues.trim()
				? {
						values: enumValues
							.split(',')
							.map((v) => v.trim())
							.filter(Boolean),
					}
				: {}),
		}

		// Check for duplicate
		const settings = workspace.settings as Record<string, unknown>
		const existingDefs =
			(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined) ?? {}
		const typeFields = existingDefs[objectType] ?? []
		if (typeFields.some((f) => f.name === trimmedName)) return

		if (onSaveField) {
			setIsPending(true)
			onSaveField(newField)
			onCreated(newField)
		}
	}

	return (
		<div className="rounded border border-border bg-card p-2 text-xs space-y-2">
			<p className="text-muted-foreground text-[10px] uppercase tracking-wider px-1">
				Create new property
			</p>
			<Input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Property name (e.g. Due Date)"
				className="h-7 text-xs"
				autoFocus
			/>
			<div className="flex gap-1 flex-wrap">
				{(['text', 'number', 'date', 'boolean', 'enum'] as const).map((t) => (
					<Button
						key={t}
						variant={type === t ? 'default' : 'secondary'}
						size="sm"
						onClick={() => setType(t)}
					>
						{t}
					</Button>
				))}
			</div>
			{type === 'enum' && (
				<Input
					type="text"
					value={enumValues}
					onChange={(e) => setEnumValues(e.target.value)}
					placeholder="Options (comma-separated)"
					className="h-7 text-xs"
				/>
			)}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" disabled={!name.trim() || isPending} onClick={handleCreate}>
					{isPending ? 'Creating...' : 'Create'}
				</Button>
			</div>
		</div>
	)
}

function FieldTypeIcon({ type }: { type: string }) {
	const icons: Record<string, string> = {
		text: 'T',
		number: '#',
		date: '📅',
		boolean: '☑',
		enum: '▤',
	}
	return (
		<span className="w-4 text-center text-muted-foreground text-[10px]">{icons[type] ?? '·'}</span>
	)
}

function inferType(value: unknown): string {
	if (typeof value === 'boolean') return 'boolean'
	if (typeof value === 'number') return 'number'
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return 'date'
	}
	return 'text'
}

function formatDisplay(value: unknown, type: string): string {
	if (value === null || value === undefined) return 'Empty'
	if (type === 'boolean') return value ? 'Yes' : 'No'
	if (type === 'date' && typeof value === 'string') {
		try {
			return new Date(value).toLocaleDateString()
		} catch {
			return String(value)
		}
	}
	return String(value)
}

function getDefaultValue(field: FieldDefinition): SafeJsonValue {
	switch (field.type) {
		case 'boolean':
			return false
		case 'number':
			return 0
		case 'date':
			return new Date().toISOString().slice(0, 10)
		case 'enum':
			return field.values?.[0] ?? ''
		default:
			return ''
	}
}
