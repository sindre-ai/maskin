// Marketplace loops that install an extension into a workspace.
//
// Extensions used to be toggled by hand in Settings → General. That surface is
// gone — a workspace gets an extension by installing the matching loop, the
// same path it uses for agents, skills and triggers.
//
// Renaming a slug here does NOT rename the marketplace row — seedMarketplaceLoops
// upserts by slug, so the old row survives and the marketplace shows both. These
// three first shipped as '*-module-loop' and needed migration 0053 to clean up
// after the rename to '*-extension-loop'. If you rename one again, write the
// matching delete migration in the same change.
//
// These three are deliberately minimal: one extension item each, no agents or
// triggers yet. They exist so the extensions a workspace can enable are
// reachable through the marketplace at all. Adding the agents and skills that
// make each one useful (e.g. a CRM enricher alongside the CRM extension) is the
// intended next step — do that by adding actorIds/skillIds/triggerIds to the
// configs in dev-bootstrap.ts and bumping EXTENSION_LOOP_VERSION so the version
// pusher propagates it to existing installs.

import {
	CRM_EXTENSION_LOOP_DESCRIPTION,
	CRM_EXTENSION_LOOP_NAME,
	CRM_EXTENSION_LOOP_SLUG,
	EXTENSION_ITEM_ID_CRM,
	EXTENSION_ITEM_ID_KNOWLEDGE,
	EXTENSION_ITEM_ID_WORK,
	EXTENSION_LOOP_USE_CASE,
	EXTENSION_LOOP_VERSION,
	KNOWLEDGE_EXTENSION_LOOP_DESCRIPTION,
	KNOWLEDGE_EXTENSION_LOOP_NAME,
	KNOWLEDGE_EXTENSION_LOOP_SLUG,
	WORK_EXTENSION_LOOP_DESCRIPTION,
	WORK_EXTENSION_LOOP_NAME,
	WORK_EXTENSION_LOOP_SLUG,
} from '@maskin/shared'
import type { ExtensionData } from './loop-data'

export { extensionSnapshot } from './loop-snapshot'

export const WORK_EXTENSION_LOOP = {
	slug: WORK_EXTENSION_LOOP_SLUG,
	name: WORK_EXTENSION_LOOP_NAME,
	version: EXTENSION_LOOP_VERSION,
	useCase: EXTENSION_LOOP_USE_CASE,
	description: WORK_EXTENSION_LOOP_DESCRIPTION,
} as const

export const WORK_EXTENSION_ITEMS: readonly ExtensionData[] = [
	{
		id: EXTENSION_ITEM_ID_WORK,
		extensionId: 'work',
		name: 'Work',
		description: 'Insights, bets and tasks.',
	},
]

export const KNOWLEDGE_EXTENSION_LOOP = {
	slug: KNOWLEDGE_EXTENSION_LOOP_SLUG,
	name: KNOWLEDGE_EXTENSION_LOOP_NAME,
	version: EXTENSION_LOOP_VERSION,
	useCase: EXTENSION_LOOP_USE_CASE,
	description: KNOWLEDGE_EXTENSION_LOOP_DESCRIPTION,
} as const

export const KNOWLEDGE_EXTENSION_ITEMS: readonly ExtensionData[] = [
	{
		id: EXTENSION_ITEM_ID_KNOWLEDGE,
		extensionId: 'knowledge',
		name: 'Knowledge',
		description: 'Articles.',
	},
]

export const CRM_EXTENSION_LOOP = {
	slug: CRM_EXTENSION_LOOP_SLUG,
	name: CRM_EXTENSION_LOOP_NAME,
	version: EXTENSION_LOOP_VERSION,
	useCase: EXTENSION_LOOP_USE_CASE,
	description: CRM_EXTENSION_LOOP_DESCRIPTION,
} as const

export const CRM_EXTENSION_ITEMS: readonly ExtensionData[] = [
	{
		id: EXTENSION_ITEM_ID_CRM,
		extensionId: 'crm',
		name: 'CRM',
		description: 'Contacts and companies.',
	},
]
