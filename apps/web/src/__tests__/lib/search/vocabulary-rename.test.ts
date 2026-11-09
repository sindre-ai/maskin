import { buildVocabulary, pillLabel } from '@/lib/search/vocabulary'
import { describe, expect, it } from 'vitest'

describe('buildVocabulary after the Loop to Flow rename', () => {
	const vocab = buildVocabulary([])

	it('resolves both the old and the new word to the flow scope', () => {
		for (const word of ['loop', 'loops', 'flow', 'flows']) {
			expect(vocab.typeWords.get(word)).toBe('loop')
		}
	})

	it('shows the flow scope as Flows in a pill', () => {
		expect(pillLabel(vocab, 'type', 'loop')).toBe('Flows')
	})
})
