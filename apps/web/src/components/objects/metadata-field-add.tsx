import { PropertyTypeGrid } from '@/components/objects/property-type-grid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import type { SafeJsonValue } from '@maskin/shared'
import { useState } from 'react'

interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

/** Split the comma-separated options a Select property is created with. */
export function parseOptions(raw: string): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const part of raw.split(',')) {
		const v = part.trim()
		if (!v || seen.has(v.toLowerCase())) continue
		seen.add(v.toLowerCase())
		out.push(v)
	}
	return out
}

/** Turn the form's string value into what metadata stores, or null when it is
 *  not valid for the type (the form then stays open instead of saving junk). */
export function coerceValue(
	field: FieldDefinition,
	value: string,
): string | number | boolean | null {
	switch (field.type) {
		case 'number': {
			if (value.trim() === '') return null
			const num = Number(value)
			return Number.isFinite(num) ? num : null
		}
		case 'boolean':
			return value === 'true'
		case 'date':
			return value ? value : null
		case 'enum':
			return field.values && !field.values.includes(value) ? null : value
		default:
			return value
	}
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
	const [customType, setCustomType] = useState<FieldDefinition['type']>('text')
	const [optionsRaw, setOptionsRaw] = useState('')
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

	// A custom name collides with anything already on the object or already
	// defined for this type, case-insensitively: two "Priority" rows would read
	// as one property with two values.
	const takenNames = new Set([
		...Object.keys(object.metadata ?? {}).map((k) => k.toLowerCase()),
		...fieldDefs.map((f) => f.name.toLowerCase()),
	])
	const trimmedKey = customKey.trim()
	const duplicate =
		mode === 'custom' && trimmedKey !== '' && takenNames.has(trimmedKey.toLowerCase())
	const customOptions = parseOptions(optionsRaw)
	const customField: FieldDefinition = {
		name: trimmedKey,
		type: customType,
		values: customType === 'enum' ? customOptions : undefined,
	}

	const handleAdd = () => {
		const field = mode === 'defined' ? selectedField : customField
		const key = field?.name ?? ''
		if (!field || !key || duplicate) return
		if (field.type === 'enum' && (field.values?.length ?? 0) === 0) return
		const parsedValue = coerceValue(field, value)
		if (parsedValue === null) return

		const metadata = { ...(object.metadata ?? {}), [key]: parsedValue as SafeJsonValue }
		updateObject.mutate({ id: object.id, data: { metadata } })
		resetForm()
	}

	const resetForm = () => {
		setSelectedField(null)
		setCustomKey('')
		setCustomType('text')
		setOptionsRaw('')
		setValue('')
		setOpen(false)
		setMode('defined')
	}

	if (!open) {
		return (
			<Button variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => setOpen(true)}>
				+ add field
			</Button>
		)
	}

	return (
		<div className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-3 text-xs sm:max-w-sm">
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
				<div className="flex flex-col gap-2.5">
					<div className="flex flex-col gap-1">
						<label htmlFor="property-name" className="eyebrow">
							NAME
						</label>
						<Input
							id="property-name"
							type="text"
							value={customKey}
							onChange={(e) => setCustomKey(e.target.value)}
							placeholder="key"
							aria-invalid={duplicate}
							aria-describedby={duplicate ? 'property-name-error' : undefined}
							className="max-md:h-11"
						/>
						{duplicate && (
							<p id="property-name-error" role="alert" className="text-xs text-error">
								A property called {trimmedKey} already exists here.
							</p>
						)}
					</div>
					<div className="flex min-w-0 flex-col gap-1">
						<span className="eyebrow">TYPE</span>
						<PropertyTypeGrid
							value={customType}
							aria-label="Property type"
							onChange={(t) => {
								setCustomType(t)
								setValue(t === 'boolean' ? 'true' : '')
							}}
						/>
					</div>
					{customType === 'enum' && (
						<div className="flex flex-col gap-1">
							<label htmlFor="property-options" className="eyebrow">
								OPTIONS
							</label>
							<Input
								id="property-options"
								type="text"
								value={optionsRaw}
								onChange={(e) => {
									setOptionsRaw(e.target.value)
									setValue('')
								}}
								placeholder="Low, Medium, High"
								className="max-md:h-11"
							/>
						</div>
					)}
					<div className="flex flex-col gap-1">
						<span className="eyebrow">VALUE</span>
						<div className="flex flex-wrap items-center gap-2">
							{customType === 'text' ? (
								<Input
									type="text"
									value={value}
									onChange={(e) => setValue(e.target.value)}
									placeholder="value"
									className="min-w-0 flex-1 max-md:h-11"
									onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
								/>
							) : (
								<FieldInput
									field={customField}
									value={value}
									onChange={setValue}
									onSubmit={handleAdd}
								/>
							)}
							<Button
								size="sm"
								className="max-md:min-h-11"
								onClick={handleAdd}
								disabled={!trimmedKey || duplicate}
							>
								Add
							</Button>
						</div>
					</div>
				</div>
			)}

			<Button variant="ghost" size="sm" className="self-start max-md:min-h-11" onClick={resetForm}>
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
				<Input
					type="number"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="w-28 max-md:h-11"
					onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
				/>
			)
		case 'date':
			return (
				<Input
					type="date"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="w-40 max-md:h-11"
				/>
			)
		default:
			return (
				<Input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="w-40 max-md:h-11"
					onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
				/>
			)
	}
}
