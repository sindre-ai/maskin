// Not followed by more id-like characters, so `/objects/<uuid>x` or a longer slug is no match.
const OBJECT_LINK =
	/\/objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/gi

const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1(?!`)/g

/** The text with fenced blocks and inline code spans removed: an address in code is not a link. */
function withoutCode(content: string): string {
	return content.replace(FENCED_CODE, '$1').replace(INLINE_CODE, '')
}

/**
 * The objects a message links to, in the order they first appear, without
 * repeats. Agents refer to an object by a link to its page, so a link is the
 * signal that the reader would want to see what is behind it.
 */
export function extractLinkedObjectIds(content: string, max = 3): string[] {
	const ids: string[] = []
	for (const match of withoutCode(content).matchAll(OBJECT_LINK)) {
		const id = match[1].toLowerCase()
		if (!ids.includes(id)) ids.push(id)
		if (ids.length >= max) break
	}
	return ids
}

const FILE_LINK =
	/\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/gi

/**
 * The files a message links to (an HTML page, a document, a picture), in the order they first
 * appear, without repeats. Same signal as {@link extractLinkedObjectIds}: a link to a file
 * means the reader would want to see what is behind it.
 */
export function extractLinkedFileIds(content: string, max = 3): string[] {
	const ids: string[] = []
	for (const match of withoutCode(content).matchAll(FILE_LINK)) {
		const id = match[1].toLowerCase()
		if (!ids.includes(id)) ids.push(id)
		if (ids.length >= max) break
	}
	return ids
}

/**
 * Whether an object deserves a card in chat and in the drawer: it is something a person acts
 * on, a draft an integration can deliver (it has a `preview`). A contact, a company or a plain
 * task is a reference, and stays a link. Files are decided by type, not here.
 */
export function hasPreviewCard(object: { preview?: unknown | null } | null | undefined): boolean {
	return Boolean(object?.preview)
}

/**
 * Whether a fetched object gets a card here: it is in this workspace, it is a draft worth acting
 * on (see {@link hasPreviewCard}) and it has text to show. Anything else stays a plain link.
 */
export function showsObjectCard(
	object:
		| { workspaceId: string; content?: string | null; preview?: unknown | null }
		| null
		| undefined,
	workspaceId: string,
): boolean {
	return Boolean(
		object &&
			object.workspaceId === workspaceId &&
			hasPreviewCard(object) &&
			object.content?.trim(),
	)
}

/** What a link in a message points at. */
export interface LinkedTarget {
	kind: 'object' | 'file'
	id: string
}

/** The few fields of a hast node the placement rules read; `react-markdown` hands these out. */
export interface HastNode {
	type: string
	tagName?: string
	value?: string
	properties?: Record<string, unknown>
	data?: Record<string, unknown>
	children?: HastNode[]
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const OBJECT_HREF = new RegExp(`/objects/(${UUID})(?:[/?#]|$)`, 'i')
const FILE_HREF = new RegExp(`/files/(${UUID})(?:[/?#]|$)`, 'i')

/** The object or file a link's address points at, if it points at one. */
export function targetOfHref(href: unknown): LinkedTarget | null {
	if (typeof href !== 'string') return null
	const object = OBJECT_HREF.exec(href)
	if (object) return { kind: 'object', id: object[1].toLowerCase() }
	const file = FILE_HREF.exec(href)
	if (file) return { kind: 'file', id: file[1].toLowerCase() }
	return null
}

// A leading label such as "Draft:" or "Email to Torben:" may sit before a link on its own.
const MAX_LABEL_LENGTH = 60
// What may follow the link: closing punctuation and spaces only.
const TRAILING_PUNCTUATION = /^[\s.,;:!?)\]]*$/

function textOf(node: HastNode): string {
	if (node.type === 'text') return node.value ?? ''
	return (node.children ?? []).map(textOf).join('')
}

function hasLink(node: HastNode): boolean {
	return node.tagName === 'a' || (node.children ?? []).some((child) => hasLink(child))
}

// Bold and italic around a link (or around the label) do not make it part of a sentence.
function flatten(nodes: HastNode[]): HastNode[] {
	return nodes.flatMap((node) =>
		(node.tagName === 'strong' || node.tagName === 'em') && hasLink(node)
			? flatten(node.children ?? [])
			: [node],
	)
}

/** A paragraph that is only a link, as `markStandaloneTargets` records it on the node. */
export interface StandaloneCard {
	target: LinkedTarget
	/** The short lead-in ("Draft:") a list item keeps as text beside its card. */
	label: string | null
	/** The paragraph was made from a tight list item's loose text; it has no `<p>` of its own. */
	bare: boolean
}

/**
 * The object or file a paragraph or list item consists of and nothing else: one link, optionally
 * after a short label ending in a colon and before closing punctuation. A link inside a sentence
 * is not standalone. Those are the placement rules for replacing a link by its card in place.
 */
export function standaloneLink(
	node: HastNode,
	{ allowLabel }: { allowLabel: boolean },
): { target: LinkedTarget; label: string | null } | null {
	const parts = flatten(node.children ?? []).filter((child) => child.tagName !== 'br')
	const links = parts.filter((part) => part.tagName === 'a')
	if (links.length !== 1) return null
	const at = parts.indexOf(links[0])
	const target = targetOfHref(links[0].properties?.href)
	if (!target) return null

	const before = parts.slice(0, at)
	const after = parts.slice(at + 1)
	const isText = (part: HastNode) =>
		part.type === 'text' || part.tagName === 'strong' || part.tagName === 'em'
	if (!before.every(isText) || !after.every((part) => part.type === 'text')) return null
	if (!TRAILING_PUNCTUATION.test(after.map(textOf).join(''))) return null

	const label = before.map(textOf).join('').trim()
	if (label && !(allowLabel && label.length <= MAX_LABEL_LENGTH && label.endsWith(':'))) return null
	return { target, label: label || null }
}

export function standaloneTarget(
	node: HastNode,
	options: { allowLabel: boolean },
): LinkedTarget | null {
	return standaloneLink(node, options)?.target ?? null
}

// Where a tight list item's own text ends and a nested block begins.
const BLOCK_TAGS = new Set([
	'ul',
	'ol',
	'p',
	'blockquote',
	'pre',
	'table',
	'div',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
])
// A link in a heading, quote or table is part of that text, never a card.
const NO_CARD_TAGS = new Set(['blockquote', 'table', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const isBlank = (node: HastNode) => node.type === 'text' && !node.value?.trim()

/**
 * Finds the paragraphs and list items that are nothing but a link to an object or file and
 * records them on the node (`data.linkedCard`, a {@link StandaloneCard}) for the renderer, so
 * placement is decided once, here, and the renderer cannot disagree with it. A list item is judged
 * on its first paragraph, or on its own text when the list is tight (that text gets wrapped in a
 * paragraph node so both look the same); loose, nested and ordered lists all follow. Returns the
 * targets found.
 */
export function markStandaloneTargets(tree: HastNode): LinkedTarget[] {
	const found: LinkedTarget[] = []
	const visit = (node: HastNode, inItem: boolean) => {
		if (node.tagName && NO_CARD_TAGS.has(node.tagName)) return
		if (node.tagName === 'li') {
			const children = node.children ?? []
			const first = children.find((child) => !isBlank(child))
			if (first && first.tagName !== 'p') {
				const end = children.findIndex(
					(child) => child.tagName !== undefined && BLOCK_TAGS.has(child.tagName),
				)
				const leading = end === -1 ? children : children.slice(0, end)
				const probe: HastNode = { type: 'element', tagName: 'p', properties: {}, children: leading }
				const hit = standaloneLink(probe, { allowLabel: true })
				if (hit) {
					const card: StandaloneCard = { ...hit, bare: true }
					node.children = [
						{ ...probe, data: { linkedCard: card } },
						...(end === -1 ? [] : children.slice(end)),
					]
					found.push(hit.target)
				}
			}
		} else if (node.tagName === 'p') {
			const hit = standaloneLink(node, { allowLabel: true })
			if (hit) {
				const card: StandaloneCard = { ...hit, label: inItem ? hit.label : null, bare: false }
				node.data = { ...node.data, linkedCard: card }
				found.push(hit.target)
			}
		}
		for (const child of node.children ?? []) {
			if (child.data?.linkedCard) continue
			visit(
				child,
				node.tagName === 'li' || (inItem && node.tagName !== 'ul' && node.tagName !== 'ol'),
			)
		}
	}
	visit(tree, false)
	return found
}

/** Every object or file a link in the rendered tree points at, in order, without repeats. */
export function linkedTargetsInTree(tree: HastNode): LinkedTarget[] {
	const found: LinkedTarget[] = []
	const visit = (node: HastNode) => {
		if (node.tagName === 'a') {
			const target = targetOfHref(node.properties?.href)
			if (target && !found.some((t) => t.kind === target.kind && t.id === target.id)) {
				found.push(target)
			}
		}
		for (const child of node.children ?? []) visit(child)
	}
	visit(tree)
	return found
}
