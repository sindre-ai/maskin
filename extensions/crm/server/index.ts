import type { ModuleDefinition } from '@maskin/module-sdk'
import {
	COMPANY_DISPLAY_NAME,
	COMPANY_FIELDS,
	COMPANY_STATUSES,
	CONTACT_DISPLAY_NAME,
	CONTACT_FIELDS,
	CONTACT_STATUSES,
	CRM_DEFAULT_SETTINGS,
	CRM_RELATIONSHIP_TYPES,
	MODULE_ID,
	MODULE_NAME,
} from '../shared.js'

const crmExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'contact',
			label: CONTACT_DISPLAY_NAME,
			icon: 'user',
			defaultStatuses: CONTACT_STATUSES,
			defaultFields: CONTACT_FIELDS,
			defaultRelationshipTypes: CRM_RELATIONSHIP_TYPES,
		},
		{
			type: 'company',
			label: COMPANY_DISPLAY_NAME,
			icon: 'building-2',
			defaultStatuses: COMPANY_STATUSES,
			defaultFields: COMPANY_FIELDS,
			defaultRelationshipTypes: CRM_RELATIONSHIP_TYPES,
		},
	],
	defaultSettings: CRM_DEFAULT_SETTINGS,
}

export default crmExtension
