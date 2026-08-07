import type { MarketplaceItemType } from '@/lib/api'

export const ITEM_TYPE_LABEL: Record<MarketplaceItemType, string> = {
	actor: 'Agent',
	trigger: 'Trigger',
	skill: 'Skill',
	integration: 'Integration',
}
