// What a version push may change on an installed flow's own title and description. The flow's
// agents find it by name and read its description, so a bundle that renames the flow or adds a
// section to the description must reach installs that still carry the old shape. Anything a
// workspace has edited is left alone.

import {
	PRODUCT_USAGE_LOOP_FORMER_NAMES,
	PRODUCT_USAGE_LOOP_SLUG,
	PRODUCT_USAGE_SETUP_MARKER,
} from '@maskin/shared'

interface LoopIdentityRule {
	/** Earlier names of the flow. A title still equal to one of them is renamed. */
	formerNames: readonly string[]
	/** Text a description section starts with. Added when the description has no such section. */
	sectionMarker?: string
}

const RULES: Record<string, LoopIdentityRule> = {
	[PRODUCT_USAGE_LOOP_SLUG]: {
		formerNames: PRODUCT_USAGE_LOOP_FORMER_NAMES,
		sectionMarker: PRODUCT_USAGE_SETUP_MARKER,
	},
}

export interface LoopIdentityPatch {
	title?: string
	content?: string
}

export function loopIdentityPatch(
	source: { slug: string; name: string; description: string },
	current: { title: string | null; content: string | null },
): LoopIdentityPatch {
	const rule = RULES[source.slug]
	if (!rule) return {}
	const patch: LoopIdentityPatch = {}
	if (current.title && current.title !== source.name && rule.formerNames.includes(current.title)) {
		patch.title = source.name
	}
	const content = current.content ?? ''
	if (rule.sectionMarker && !content.includes(rule.sectionMarker)) {
		const start = source.description.indexOf(rule.sectionMarker)
		if (start >= 0) {
			const section = source.description.slice(start)
			patch.content = content.trim() === '' ? section : `${content.trimEnd()}\n\n${section}`
		}
	}
	return patch
}
