import type { CustomEventNormalizer } from '../../types'

/** Map Linear entity types (from webhook `type` field) to normalized entity types */
const ENTITY_TYPE_MAP: Record<string, string> = {
	Issue: 'linear.issue',
	Comment: 'linear.comment',
	Project: 'linear.project',
	Cycle: 'linear.cycle',
	Label: 'linear.label',
	IssueLabel: 'linear.label',
	ProjectUpdate: 'linear.project_update',
	Reaction: 'linear.reaction',
}

export const linearEventNormalizer: CustomEventNormalizer = (payload, _headers) => {
	const body = payload as Record<string, unknown>

	const type = body.type as string | undefined
	const action = body.action as string | undefined
	const organizationId = body.organizationId as string | undefined

	if (!type || !action || !organizationId) return null

	const entityType = ENTITY_TYPE_MAP[type]
	if (!entityType) return null

	const data = (body.data as Record<string, unknown>) ?? {}

	return {
		entityType,
		action,
		installationId: organizationId,
		data: {
			...data,
			organizationId,
			webhookType: type,
		},
	}
}
