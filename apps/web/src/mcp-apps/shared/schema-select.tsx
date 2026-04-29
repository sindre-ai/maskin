import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { type WorkspaceSchema, useWorkspaceSchema } from './use-workspace-schema'

export interface SchemaSelectProps {
	objectType: string
	/**
	 * Field name on the type schema. The literal value `'status'` is treated as
	 * a special case and resolved against the type's `statuses` list. Any other
	 * name is resolved against `fields[]` and only renders when the field's
	 * `type` is `enum`.
	 */
	field: string
	value: string | undefined
	onChange: (value: string) => void
	/** Override workspace context (defaults to the tool result's workspaceId). */
	workspaceId?: string
	/** Externally-provided schema to skip the hook (used in tests / sandboxes). */
	schemaOverride?: WorkspaceSchema | null
	disabled?: boolean
	required?: boolean
	placeholder?: string
	className?: string
	id?: string
	'aria-label'?: string
	'aria-describedby'?: string
}

function resolveOptions(
	schema: WorkspaceSchema | null,
	objectType: string,
	field: string,
): { options: string[]; resolvable: boolean } {
	if (!schema) return { options: [], resolvable: false }
	const typeSchema = schema.types[objectType]
	if (!typeSchema) return { options: [], resolvable: false }
	if (field === 'status') return { options: typeSchema.statuses, resolvable: true }
	const def = typeSchema.fields.find((f) => f.name === field)
	if (!def) return { options: [], resolvable: false }
	if (def.type !== 'enum') return { options: [], resolvable: true }
	return { options: def.values ?? [], resolvable: true }
}

/**
 * Schema-driven dropdown for any `enum`-typed field on an object type. Reads
 * options from the workspace schema returned by `get_workspace_schema`. Renders
 * a disabled placeholder while the schema loads, an empty state when the field
 * is unknown, and the resolved options once available.
 */
export function SchemaSelect({
	objectType,
	field,
	value,
	onChange,
	workspaceId,
	schemaOverride,
	disabled,
	required,
	placeholder,
	className,
	id,
	...rest
}: SchemaSelectProps) {
	const hookResult = useWorkspaceSchema(workspaceId)
	const schema = schemaOverride !== undefined ? schemaOverride : hookResult.schema
	const loading = schemaOverride !== undefined ? false : hookResult.loading
	const error = schemaOverride !== undefined ? null : hookResult.error
	const { options, resolvable } = resolveOptions(schema, objectType, field)

	const ariaLabel = rest['aria-label'] ?? `Select ${field}`
	const ariaDescribedBy = rest['aria-describedby']

	let computedPlaceholder = placeholder ?? `Select ${field}`
	if (loading) computedPlaceholder = 'Loading…'
	else if (error) computedPlaceholder = 'Schema unavailable'
	else if (schema && !resolvable) computedPlaceholder = `Unknown field: ${field}`
	else if (schema && resolvable && options.length === 0) computedPlaceholder = 'No options'

	const isDisabled = disabled || loading || !!error || !resolvable || options.length === 0

	return (
		<Select value={value ?? ''} onValueChange={onChange} disabled={isDisabled}>
			<SelectTrigger
				id={id}
				className={className}
				aria-label={ariaLabel}
				aria-describedby={ariaDescribedBy}
				aria-required={required || undefined}
				aria-invalid={required && !value ? true : undefined}
			>
				<SelectValue placeholder={computedPlaceholder} />
			</SelectTrigger>
			<SelectContent>
				{options.map((opt) => (
					<SelectItem key={opt} value={opt}>
						{opt}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
