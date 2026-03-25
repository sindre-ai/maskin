import type { SafeJsonValue } from '@ai-native/shared'
import { useUpdateObject } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

export function MetadataFieldAdd({
	object,
	workspaceId,
}: {
	object: ObjectResponse
	workspaceId: string
}) {
	const { workspace } = useWorkspace()
	const [open, setOpen] = useState(false)
	const [mode, setMode] = useState<'defined' | 'custom'>('defined')
	const [selectedField, setSelectedField] = useState<FieldDefinition | null>(null)
	const [customKey, setCustomKey] = useState('')
	const [value, setValue] = useState('')
	const updateObject = useUpdateObject(workspaceId)

	// Get field definitions for this object type from workspace settings
	const settings = workspace.settings as Record<string, unknown>
	const fieldDefs =
		(settings?.field_definitions as Record<string, FieldDefinition[]> | undefined)?.[object.type] ??
		[]

	// Filter out fields already set on this object
	const existingKeys = new Set(Object.keys(object.metadata ?? {}))
	const availableFields = fieldDefs.filter((f) => !existingKeys.has(f.name))

	const handleAdd = () => {
		const key = mode === 'defined' && selectedField ? selectedField.name : customKey.trim()
		if (!key) return

		let parsedValue: unknown = value

		// Validate/coerce based on field type
		if (mode === 'defined' && selectedField) {
			switch (selectedField.type) {
				case 'number': {
					const num = Number(value)
					if (Number.isNaN(num)) return
					parsedValue = num
					break
				}
				case 'boolean':
					parsedValue = value === 'true'
					break
				case 'date':
					if (!value) return
					parsedValue = value // stored as ISO string
					break
				case 'enum':
					if (selectedField.values && !selectedField.values.includes(value)) return
					parsedValue = value
					break
				default:
					parsedValue = value
					break
			}
		}

		const metadata = { ...(object.metadata ?? {}), [key]: parsedValue as SafeJsonValue }
		updateObject.mutate({ id: object.id, data: { metadata } })
		resetForm()
	}

	const resetForm = () => {
		setSelectedField(null)
		setCustomKey('')
		setValue('')
		setOpen(false)
		setMode('defined')
	}

	if (!open) {
		return (
			<button
				type="button"
				className="text-[11px] text-muted-foreground hover:text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				+ add field
			</button>
		)
	}

	return (
		<div className="inline-flex flex-col gap-1.5 rounded border border-border bg-card p-2 text-[11px]">
			{/* Mode selector: show defined fields or custom */}
			{availableFields.length > 0 && (
				<div className="flex gap-1 mb-1">
					<button
						type="button"
						className={`px-1.5 py-0.5 rounded ${mode === 'defined' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-muted-foreground'}`}
						onClick={() => {
							setMode('defined')
							setSelectedField(null)
							setValue('')
						}}
					>
						Defined fields
					</button>
					<button
						type="button"
						className={`px-1.5 py-0.5 rounded ${mode === 'custom' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-muted-foreground'}`}
						onClick={() => {
							setMode('custom')
							setSelectedField(null)
							setValue('')
						}}
					>
						Custom
					</button>
				</div>
			)}

			{mode === 'defined' && availableFields.length > 0 ? (
				<>
					{/* Field picker */}
					{!selectedField ? (
						<div className="space-y-0.5">
							{availableFields.map((field) => (
								<button
									key={field.name}
									type="button"
									className="flex items-center gap-2 w-full text-left rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
									onClick={() => {
										setSelectedField(field)
										if (field.type === 'boolean') setValue('true')
									}}
								>
									<span>{field.name}</span>
									<span className="text-muted-foreground">({field.type})</span>
									{field.required && <span className="text-error">*</span>}
								</button>
							))}
						</div>
					) : (
						<div className="flex items-center gap-1">
							<span className="text-muted-foreground">{selectedField.name}:</span>
							<FieldInput
								field={selectedField}
								value={value}
								onChange={setValue}
								onSubmit={handleAdd}
							/>
							<button
								type="button"
								className="text-primary hover:text-primary-hover px-1"
								onClick={handleAdd}
							>
								Add
							</button>
						</div>
					)}
				</>
			) : (
				<div className="flex items-center gap-1">
					<input
						type="text"
						value={customKey}
						onChange={(e) => setCustomKey(e.target.value)}
						placeholder="key"
						className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:border-ring outline-none"
					/>
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder="value"
						className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:border-ring outline-none"
						onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
					/>
					<button
						type="button"
						className="text-primary hover:text-primary-hover px-1"
						onClick={handleAdd}
					>
						Add
					</button>
				</div>
			)}

			<button
				type="button"
				className="text-muted-foreground hover:text-muted-foreground self-start"
				onClick={resetForm}
			>
				Cancel
			</button>
		</div>
	)
}

function FieldInput({
	field,
	value,
	onChange,
	onSubmit,
}: {
	field: FieldDefinition
	value: string
	onChange: (v: string) => void
	onSubmit: () => void
}) {
	const baseClass =
		'rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:border-ring outline-none'

	switch (field.type) {
		case 'enum':
			return (
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`${baseClass} w-24`}
				>
					<option value="">Select...</option>
					{(field.values ?? []).map((v) => (
						<option key={v} value={v}>
							{v}
						</option>
					))}
				</select>
			)
		case 'boolean':
			return (
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`${baseClass} w-16`}
				>
					<option value="true">Yes</option>
					<option value="false">No</option>
				</select>
			)
		case 'number':
			return (
				<input
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`${baseClass} w-20`}
					onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
				/>
			)
		case 'date':
			return (
				<input
					type="date"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`${baseClass} w-28`}
				/>
			)
		default:
			return (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={`${baseClass} w-24`}
					onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
				/>
			)
	}
}
