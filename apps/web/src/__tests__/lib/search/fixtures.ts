import { buildVocabulary } from '@/lib/search/vocabulary'

// The shape of this workspace's real types: Company and Person are separate types.
export const vocab = buildVocabulary([
	{ key: 'bet', label: 'Bet' },
	{ key: 'insight', label: 'Insight' },
	{ key: 'task', label: 'Task' },
	{ key: 'company', label: 'Company' },
	{ key: 'contact', label: 'Person', plural: 'People' },
	{ key: 'knowledge', label: 'Knowledge' },
	{ key: 'loop', label: 'Loop' },
])
