import type { MarketplaceItemType } from '@/lib/api'

export const ITEM_TYPE_LABEL: Record<MarketplaceItemType, string> = {
	actor: 'Agent',
	trigger: 'Trigger',
	skill: 'Skill',
	integration: 'Integration',
}

/** A loop bundle sits alongside the four item types wherever a kind is shown. */
export type MarketplaceKind = MarketplaceItemType | 'loop'

/** The mockup's kind micro-label (2589 on the card, 2633 on the detail header):
 *  mono, 10px, bold, wide-tracked — deliberately not `.eyebrow`, which locks
 *  its own colour to muted-foreground. */
export const KIND_LABEL_BASE = 'font-mono text-[10px] font-bold uppercase tracking-[0.05em]'

/** Per-kind colour for that label. Mapped onto the existing status text tokens
 *  (which carry dark-mode values) rather than the mockup's raw hexes. */
export const KIND_LABEL_CLASS: Record<MarketplaceKind, string> = {
	loop: 'text-status-proposed-text',
	actor: 'text-status-active-text',
	trigger: 'text-status-processing-text',
	skill: 'text-status-signal-text',
	integration: 'text-status-in_progress-text',
}

/** The kind a marketplace loop reads as: a single-type loop borrows its one
 *  item type, a multi-type loop is a bundle. */
export function loopKind(itemTypes: MarketplaceItemType[]): MarketplaceKind {
	return itemTypes.length === 1 ? itemTypes[0] : 'loop'
}

export function kindLabel(kind: MarketplaceKind): string {
	return kind === 'loop' ? 'Loop' : ITEM_TYPE_LABEL[kind]
}
