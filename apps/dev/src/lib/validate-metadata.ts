import type { ApiErrorDetail } from '@maskin/shared'
import { createApiError } from '@maskin/shared'
import type { WorkspaceSettings } from './types'

type FieldDefinition = WorkspaceSettings['field_definitions'][string][number]

export interface MetadataValidationOptions {
	/**
	 * 'create' enforces every `required: true` field is present in `metadata`.
	 * 'update' only checks fields the caller is explicitly setting — required
	 * fields aren't blocked by omission, but explicit null clears are rejected.
	 */
	mode: 'create' | 'update'
	/** Path prefix for error `field` strings — e.g. `nodes[0]` for graph payloads. */
	fieldPath?: string
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null
}

function formatValue(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (value === null) return 'null'
	if (typeof value === 'string') return `'${value}'`
	return String(value)
}

/**
 * Validate object metadata against a workspace's `field_definitions[type]`.
 *
 * - `required: true` fields must be present (non-null) on create. On update,
 *   omitting the key is fine, but explicitly setting it to null is rejected so
 *   the field can't be cleared past the constraint.
 * - `enum` fields with `values: [...]` must match one of those values whenever
 *   the caller submits a value for that field.
 *
 * Returns an empty array when valid.
 */
export function validateMetadataFields(
	type: string,
	metadata: Record<string, unknown> | null | undefined,
	fieldDefinitions: FieldDefinition[] | undefined,
	options: MetadataValidationOptions,
): ApiErrorDetail[] {
	if (!fieldDefinitions || fieldDefinitions.length === 0) return []

	const meta = metadata ?? {}
	const errors: ApiErrorDetail[] = []
	const prefix = options.fieldPath ? `${options.fieldPath}.metadata` : 'metadata'

	for (const field of fieldDefinitions) {
		const submitted = Object.hasOwn(meta, field.name)
		const value = meta[field.name]
		const fieldPath = `${prefix}.${field.name}`

		if (field.required) {
			if (options.mode === 'create' && isMissing(value)) {
				errors.push({
					field: fieldPath,
					message: `Required metadata field '${field.name}' is missing for type '${type}'`,
					expected: 'non-null value',
					received: formatValue(value),
				})
				continue
			}
			if (options.mode === 'update' && submitted && isMissing(value)) {
				errors.push({
					field: fieldPath,
					message: `Required metadata field '${field.name}' cannot be cleared for type '${type}'`,
					expected: 'non-null value',
					received: formatValue(value),
				})
				continue
			}
		}

		if (field.type === 'enum' && field.values && field.values.length > 0) {
			if (submitted && !isMissing(value)) {
				if (typeof value !== 'string' || !field.values.includes(value)) {
					errors.push({
						field: fieldPath,
						message: `Invalid value for enum field '${field.name}'`,
						expected: field.values.map((v) => `'${v}'`).join(' | '),
						received: formatValue(value),
					})
				}
			}
		}
	}

	return errors
}

/** Build a structured 400 response from validation errors. */
export function createMetadataValidationError(type: string, errors: ApiErrorDetail[]) {
	const first = errors[0]
	return createApiError(
		'BAD_REQUEST',
		errors.length === 1 && first ? first.message : `Metadata validation failed for type '${type}'`,
		errors,
		`Check field definitions for type '${type}' in workspace settings`,
	)
}
