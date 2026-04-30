import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'crm' as const
export const MODULE_NAME = 'CRM'

export const CONTACT_DISPLAY_NAME = 'Contact'
export const COMPANY_DISPLAY_NAME = 'Company'

export const CONTACT_STATUSES = [
	'new_lead',
	'connection_requested',
	'messaged',
	'in_conversation',
	'meeting_booked',
	'converted',
	'not_interested',
	'follow_up_later',
]

export const COMPANY_STATUSES = [
	'prospect',
	'icp_match',
	'engaged',
	'customer',
	'churned',
	'not_a_fit',
]

export const CRM_RELATIONSHIP_TYPES = ['relates_to', 'works_at', 'decision_maker_at']

export const CONTACT_FIELDS: FieldDefinition[] = [
	{ name: 'linkedin_url', type: 'text' },
	{ name: 'email', type: 'text' },
	{ name: 'company', type: 'text' },
	{ name: 'position', type: 'text' },
	{ name: 'connected_on', type: 'date' },
	{ name: 'last_contacted', type: 'date' },
	{ name: 'notes', type: 'text' },
	{ name: 'lead_source', type: 'text' },
	{ name: 'priority', type: 'enum', values: ['hot', 'warm', 'cold'] },
	{
		name: 'outreach_stage',
		type: 'enum',
		values: ['not_started', 'first_touch', 'follow_up_1', 'follow_up_2', 'breakup', 'completed'],
	},
	{
		name: 'response_status',
		type: 'enum',
		values: ['no_reply', 'replied', 'engaged', 'bounced'],
	},
	{
		name: 'icp_score',
		type: 'enum',
		values: ['perfect', 'strong', 'moderate', 'weak', 'not_fit'],
	},
	{ name: 'icp_reasoning', type: 'text' },
]

export const COMPANY_FIELDS: FieldDefinition[] = [
	{ name: 'website', type: 'text' },
	{ name: 'industry', type: 'text' },
	{
		name: 'size',
		type: 'enum',
		values: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'],
	},
	{
		name: 'icp_score',
		type: 'enum',
		values: ['perfect', 'strong', 'moderate', 'weak'],
	},
	{ name: 'notes', type: 'text' },
]

export const CRM_DEFAULT_SETTINGS: ModuleDefaultSettings = {
	display_names: {
		contact: CONTACT_DISPLAY_NAME,
		company: COMPANY_DISPLAY_NAME,
	},
	statuses: {
		contact: CONTACT_STATUSES,
		company: COMPANY_STATUSES,
	},
	field_definitions: {
		contact: CONTACT_FIELDS,
		company: COMPANY_FIELDS,
	},
	relationship_types: CRM_RELATIONSHIP_TYPES,
}
