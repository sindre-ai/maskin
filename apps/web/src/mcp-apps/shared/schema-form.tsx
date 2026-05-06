import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { type FormEvent, useMemo, useState } from 'react'
import { SchemaSelect } from './schema-select'
import {
	type SchemaFieldDef,
	type WorkspaceSchema,
	useWorkspaceSchema,
} from './use-workspace-schema'

export interface SchemaFormProps {
	objectType: string
	values: Record<string, unknown>
	onChange: (values: Record<string, unknown>) => void
	onSubmit?: (values: Record<string, unknown>) => void | Promise<void>
	workspaceId?: string
	/** External schema (skips the hook). Useful for tests and sandboxes. */
	schemaOverride?: WorkspaceSchema | null
	/** Subset of field names to render. Omit to render all schema fields. */
	fieldNames?: string[]
	/** When true, a submit button is rendered. Defaults to true when onSubmit is supplied. */
	showSubmit?: boolean
	submitLabel?: string
	disabled?: boolean
	className?: string
}

interface FieldErrors {
	[fieldName: string]: string
}

function fieldLabel(field: SchemaFieldDef): string {
	return field.name.replace(/_/g, ' ')
}

function validate(values: Record<string, unknown>, fields: SchemaFieldDef[]): FieldErrors {
	const errors: FieldErrors = {}
	for (const f of fields) {
		const v = values[f.name]
		if (f.required) {
			const isEmpty =
				v === undefined ||
				v === null ||
				(typeof v === 'string' && v.trim() === '') ||
				(Array.isArray(v) && v.length === 0)
			if (isEmpty) {
				errors[f.name] = `${fieldLabel(f)} is required`
				continue
			}
		}
		if (f.type === 'number' && v !== undefined && v !== null && v !== '') {
			const n = typeof v === 'number' ? v : Number(v)
			if (Number.isNaN(n)) errors[f.name] = `${fieldLabel(f)} must be a number`
		}
		if (f.type === 'enum' && v !== undefined && v !== null && v !== '' && f.values) {
			if (!f.values.includes(String(v))) {
				errors[f.name] = `${fieldLabel(f)} must be one of: ${f.values.join(', ')}`
			}
		}
	}
	return errors
}

/**
 * Schema-driven form for the custom metadata fields of an object type. Renders
 * one input per field declared on `get_workspace_schema`, dispatching by field
 * type to a typed widget (text, number, date, enum select, boolean toggle).
 * Validation runs on submit and surfaces errors inline.
 *
 * The form is controlled — pass `values` and react to `onChange`. Provide
 * `onSubmit` to render a submit button and run validation on click.
 */
export function SchemaForm({
	objectType,
	values,
	onChange,
	onSubmit,
	workspaceId,
	schemaOverride,
	fieldNames,
	showSubmit,
	submitLabel = 'Save',
	disabled,
	className,
}: SchemaFormProps) {
	const hookResult = useWorkspaceSchema(workspaceId)
	const schema = schemaOverride !== undefined ? schemaOverride : hookResult.schema
	const loading = schemaOverride !== undefined ? false : hookResult.loading
	const error = schemaOverride !== undefined ? null : hookResult.error

	const fields = useMemo<SchemaFieldDef[]>(() => {
		const all = schema?.types[objectType]?.fields ?? []
		if (!fieldNames) return all
		const set = new Set(fieldNames)
		return all.filter((f) => set.has(f.name))
	}, [schema, objectType, fieldNames])

	const [errors, setErrors] = useState<FieldErrors>({})
	const [submitting, setSubmitting] = useState(false)

	const setFieldValue = (name: string, next: unknown) => {
		onChange({ ...values, [name]: next })
		if (errors[name]) {
			const { [name]: _omit, ...rest } = errors
			setErrors(rest)
		}
	}

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!onSubmit) return
		const validationErrors = validate(values, fields)
		setErrors(validationErrors)
		if (Object.keys(validationErrors).length > 0) return
		setSubmitting(true)
		try {
			await onSubmit(values)
		} finally {
			setSubmitting(false)
		}
	}

	if (loading) {
		return <p className={className ?? 'text-xs text-muted-foreground'}>Loading schema…</p>
	}
	if (error) {
		return <p className={className ?? 'text-xs text-destructive'}>Failed to load schema: {error}</p>
	}
	if (!schema?.types[objectType]) {
		return (
			<p className={className ?? 'text-xs text-muted-foreground'}>
				Unknown object type: {objectType}
			</p>
		)
	}
	if (fields.length === 0) {
		return (
			<p className={className ?? 'text-xs text-muted-foreground'}>
				No editable metadata fields for {objectType}.
			</p>
		)
	}

	const shouldShowSubmit = showSubmit ?? Boolean(onSubmit)

	return (
		<form className={className ?? 'space-y-3'} onSubmit={handleSubmit} noValidate>
			{fields.map((f) => {
				const v = values[f.name]
				const inputId = `schemaform-${objectType}-${f.name}`
				const errId = `${inputId}-err`
				const errMsg = errors[f.name]
				return (
					<div key={f.name} className="space-y-1">
						<Label htmlFor={inputId} className="text-xs text-muted-foreground capitalize">
							{fieldLabel(f)}
							{f.required ? <span className="ml-0.5 text-destructive">*</span> : null}
						</Label>
						{f.type === 'enum' ? (
							<SchemaSelect
								id={inputId}
								objectType={objectType}
								field={f.name}
								value={typeof v === 'string' ? v : undefined}
								onChange={(next) => setFieldValue(f.name, next)}
								workspaceId={workspaceId}
								schemaOverride={schema}
								required={f.required}
								disabled={disabled}
								aria-describedby={errMsg ? errId : undefined}
							/>
						) : f.type === 'boolean' ? (
							<div className="flex items-center gap-2">
								<Switch
									id={inputId}
									checked={v === true}
									onCheckedChange={(checked) => setFieldValue(f.name, checked)}
									disabled={disabled}
									aria-describedby={errMsg ? errId : undefined}
								/>
								<span className="text-xs text-muted-foreground">{v === true ? 'On' : 'Off'}</span>
							</div>
						) : f.type === 'number' ? (
							<Input
								id={inputId}
								type="number"
								value={v === undefined || v === null ? '' : String(v)}
								onChange={(e) => {
									const raw = e.target.value
									if (raw === '') {
										setFieldValue(f.name, undefined)
									} else {
										const num = Number(raw)
										setFieldValue(f.name, Number.isNaN(num) ? raw : num)
									}
								}}
								disabled={disabled}
								aria-invalid={errMsg ? true : undefined}
								aria-describedby={errMsg ? errId : undefined}
								required={f.required}
							/>
						) : f.type === 'date' ? (
							<Input
								id={inputId}
								type="date"
								value={typeof v === 'string' ? v : ''}
								onChange={(e) => setFieldValue(f.name, e.target.value || undefined)}
								disabled={disabled}
								aria-invalid={errMsg ? true : undefined}
								aria-describedby={errMsg ? errId : undefined}
								required={f.required}
							/>
						) : (
							<Input
								id={inputId}
								type="text"
								value={typeof v === 'string' ? v : v == null ? '' : String(v)}
								onChange={(e) => setFieldValue(f.name, e.target.value)}
								disabled={disabled}
								aria-invalid={errMsg ? true : undefined}
								aria-describedby={errMsg ? errId : undefined}
								required={f.required}
							/>
						)}
						{errMsg ? (
							<p id={errId} className="text-xs text-destructive">
								{errMsg}
							</p>
						) : null}
					</div>
				)
			})}
			{shouldShowSubmit ? (
				<div className="pt-2">
					<Button type="submit" size="sm" disabled={disabled || submitting}>
						{submitting ? 'Saving…' : submitLabel}
					</Button>
				</div>
			) : null}
		</form>
	)
}
