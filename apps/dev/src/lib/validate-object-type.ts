import { getValidObjectTypes } from '@ai-native/module-sdk'
import { createApiError } from './errors'
import type { WorkspaceSettings } from './types'

/**
 * Validate that an object type is enabled in the workspace's module configuration.
 * Returns an error response body + status if invalid, or null if valid.
 */
export function validateObjectType(
	settings: WorkspaceSettings,
	type: string,
	fieldPrefix?: string,
): { error: ReturnType<typeof createApiError>; status: 400 } | null {
	const enabledModules = (settings as WorkspaceSettings & { enabled_modules?: string[] })
		.enabled_modules ?? ['work']
	const validTypes = getValidObjectTypes(enabledModules)
	if (validTypes.length > 0 && !validTypes.includes(type)) {
		const field = fieldPrefix ? `${fieldPrefix}.type` : 'type'
		return {
			error: createApiError(
				'VALIDATION_ERROR',
				`Object type '${type}' is not enabled in this workspace`,
				[
					{
						field,
						message: `'${type}' is not an enabled object type`,
						expected: validTypes.map((t) => `'${t}'`).join(' | '),
						received: `'${type}'`,
					},
				],
				`Enabled types: ${validTypes.join(', ')}`,
			),
			status: 400,
		}
	}
	return null
}
