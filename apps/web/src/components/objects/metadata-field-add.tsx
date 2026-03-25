import { Button } from '@/components/ui/button'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUpdateObject } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import type { SafeJsonValue } from '@ai-native/shared'
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
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
				+ add field
			</Button>
		)
	}

	return (
		<div className="inline-flex flex-col gap-1.5 rounded border border-border bg-card p-2 text-[11px]">
			{/* Mode selector: show defined fields or custom */}
			{availableFields.length > 0 && (
				<Tabs
					value={mode}
					onValueChange={(v) => {
						setMode(v as 'defined' | 'custom')
						setSelectedField(null)
						setValue('')
					}}
					className="mb-1"
				>
					<TabsList className="h-auto p-0.5">
						<TabsTrigger value="defined" className="text-[11px] px-1.5 py-0.5">
							Defined fields
						</TabsTrigger>
						<TabsTrigger value="custom" className="text-[11px] px-1.5 py-0.5">
							Custom
						</TabsTrigger>
					</TabsList>
				</Tabs>
			)}

			{mode === 'defined' && availableFields.length > 0 ? (
				<>
					{/* Field picker */}
					{!selectedField ? (
						<div className="space-y-0.5">
							{availableFields.map((field) => (
								<Button
									key={field.name}
									type="button"
									variant="ghost"
									className="w-full justify-start"
									onClick={() => {
										setSelectedField(field)
										if (field.type === 'boolean') setValue('true')
									}}
								>
									<span>{field.name}</span>
									<span className="text-muted-foreground">({field.type})</span>
									{field.required && <span className="text-error">*</span>}
								</Button>
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
							<Button variant="ghost" size="sm" onClick={handleAdd}>
								Add
							</Button>
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
					<Button variant="ghost" size="sm" onClick={handleAdd}>
						Add
					</Button>
				</div>
			)}

			<Button variant="ghost" size="sm" className="self-start" onClick={resetForm}>
				Cancel
			</Button>
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
				<Select value={value} onValueChange={onChange}>
					<SelectTrigger>
						<SelectValue placeholder="Select..." />
					</SelectTrigger>
					<SelectContent>
						{(field.values ?? []).map((v) => (
							<SelectItem key={v} value={v}>
								{v}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)
		case 'boolean':
			return (
				<Select value={value} onValueChange={onChange}>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">Yes</SelectItem>
						<SelectItem value="false">No</SelectItem>
					</SelectContent>
				</Select>
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
