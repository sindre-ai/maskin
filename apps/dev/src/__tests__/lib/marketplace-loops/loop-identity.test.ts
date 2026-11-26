import { PRODUCT_USAGE_SETUP_SECTION } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { loopIdentityPatch } from '../../../lib/marketplace-loops/loop-identity'

const source = {
	slug: 'product-usage-loop',
	name: 'Product Analytics',
	description: `Reads real usage.\n\n${PRODUCT_USAGE_SETUP_SECTION}`,
}

describe('loopIdentityPatch', () => {
	it('renames an install still on the old name', () => {
		const patch = loopIdentityPatch(source, {
			title: 'Product Usage',
			content: `Old text.\n\n${PRODUCT_USAGE_SETUP_SECTION}`,
		})
		expect(patch).toEqual({ title: 'Product Analytics' })
	})

	it('keeps a name the workspace chose', () => {
		const patch = loopIdentityPatch(source, {
			title: 'Our usage flow',
			content: `x\n\n${PRODUCT_USAGE_SETUP_SECTION}`,
		})
		expect(patch.title).toBeUndefined()
	})

	it('adds the Setup section to a description that has none, keeping the text', () => {
		const patch = loopIdentityPatch(source, { title: 'Product Usage', content: 'Our own words.' })
		expect(patch.content).toBe(`Our own words.\n\n${PRODUCT_USAGE_SETUP_SECTION}`)
	})

	it('leaves a description that already has Setup alone', () => {
		const patch = loopIdentityPatch(source, {
			title: 'Product Analytics',
			content: '**Setup (filled in)**\n\n- Product and platforms: web app',
		})
		expect(patch).toEqual({})
	})

	it('does nothing for a flow with no identity rule', () => {
		expect(
			loopIdentityPatch(
				{ slug: 'meeting-loop', name: 'Meeting', description: 'x' },
				{ title: 'Product Usage', content: null },
			),
		).toEqual({})
	})
})
