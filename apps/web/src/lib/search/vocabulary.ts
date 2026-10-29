// Words the search field understands: which typed words name an object type and
// which name a status group. Pure data, built from the workspace's real types, so
// a workspace without a given type never gets a pill for it.
//
// Status groups are global (not per type), so a status word works with or without
// a type pill. Pill values are wire values: a type key (chat, loop, company, ...)
// or a status group key (needs_you, ...), the same strings the URL carries.

export const STATUS_GROUPS = ['needs_you', 'in_progress', 'new', 'done', 'archived'] as const
export type StatusGroup = (typeof STATUS_GROUPS)[number]

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
	needs_you: 'Needs you',
	in_progress: 'In progress',
	new: 'New',
	done: 'Done',
	archived: 'Archived',
}

export function isStatusGroup(value: string): value is StatusGroup {
	return (STATUS_GROUPS as readonly string[]).includes(value)
}

export interface VocabularyType {
	key: string
	/** Singular display name, e.g. "Company". */
	label: string
	/** Plural display name; defaults to a regular plural of label. */
	plural?: string
}

/** Scopes that exist in every workspace. Loops are objects server-side but a scope here. */
const SCOPE_TYPES: VocabularyType[] = [
	{ key: 'chat', label: 'Chat' },
	{ key: 'loop', label: 'Loop' },
	{ key: 'agent', label: 'Agent' },
	{ key: 'automation', label: 'Automation' },
]

// Typed synonyms for a type key. They only activate when that key exists.
const TYPE_SYNONYMS: Record<string, string[]> = {
	company: ['customer', 'customers', 'client', 'clients', 'account', 'accounts'],
	contact: ['person', 'persons', 'people'],
	knowledge: ['doc', 'docs', 'document', 'documents'],
}

const STATUS_WORDS: Record<string, StatusGroup> = {
	'needs you': 'needs_you',
	needs: 'needs_you',
	waiting: 'needs_you',
	blocked: 'needs_you',
	pending: 'needs_you',
	awaiting: 'needs_you',
	'at risk': 'needs_you',
	active: 'in_progress',
	'in progress': 'in_progress',
	running: 'in_progress',
	working: 'in_progress',
	ongoing: 'in_progress',
	doing: 'in_progress',
	watching: 'in_progress',
	new: 'new',
	draft: 'new',
	drafts: 'new',
	proposed: 'new',
	unread: 'new',
	done: 'done',
	completed: 'done',
	shipped: 'done',
	published: 'done',
	finished: 'done',
	resolved: 'done',
	closed: 'done',
	archived: 'archived',
	dropped: 'archived',
	paused: 'archived',
	churned: 'archived',
}

/** A person or agent that can be picked in the @ menu. */
export interface ParticipantOption {
	id: string
	name: string
	type: 'human' | 'agent'
}

export interface Vocabulary {
	/** Lowercase typed word (one word) to type key. */
	typeWords: ReadonlyMap<string, string>
	/** Lowercase typed word or two-word phrase to status group. */
	statusWords: ReadonlyMap<string, StatusGroup>
	/** Type key to plural display name. */
	typeLabels: ReadonlyMap<string, string>
	/** Actor id to the person or agent it names: the participant pill label and the @ menu rows. */
	participants: ReadonlyMap<string, ParticipantOption>
}

function pluralize(label: string): string {
	if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`
	if (/(s|x|ch|sh)$/i.test(label)) return `${label}es`
	return `${label}s`
}

/**
 * Builds the alias tables. `objectTypes` are the workspace's real object types;
 * the four scopes (chat, loop, agent, automation) are always added. A type listed
 * in both (loop) is kept once.
 */
export function buildVocabulary(
	objectTypes: VocabularyType[],
	participants: ParticipantOption[] = [],
): Vocabulary {
	const types = new Map<string, VocabularyType>()
	for (const t of [...SCOPE_TYPES, ...objectTypes]) {
		if (!types.has(t.key)) types.set(t.key, t)
	}

	const typeWords = new Map<string, string>()
	const typeLabels = new Map<string, string>()
	for (const t of types.values()) {
		const plural = t.plural ?? pluralize(t.label)
		typeLabels.set(t.key, plural)
		for (const w of [t.key, `${t.key}s`, t.label, plural]) {
			const word = w.toLowerCase()
			// A word is claimed by the first type that uses it.
			if (!typeWords.has(word) && !/\s/.test(word)) typeWords.set(word, t.key)
		}
	}
	for (const [key, words] of Object.entries(TYPE_SYNONYMS)) {
		if (!types.has(key)) continue
		for (const w of words) if (!typeWords.has(w)) typeWords.set(w, key)
	}

	return {
		typeWords,
		statusWords: new Map(Object.entries(STATUS_WORDS)),
		typeLabels,
		participants: new Map(participants.map((p) => [p.id, p])),
	}
}

export type PillKind = 'type' | 'status' | 'participant'

export function pillLabel(vocab: Vocabulary, kind: PillKind, value: string): string {
	if (kind === 'participant') {
		const participant = vocab.participants.get(value)
		return participant ? `@${participant.name}` : '@Unknown'
	}
	if (kind === 'status') return isStatusGroup(value) ? STATUS_GROUP_LABELS[value] : value
	return vocab.typeLabels.get(value) ?? value
}
