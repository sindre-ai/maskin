const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

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
	kind: 'object' | 'file' | 'loop' | 'trigger' | 'agent'
	id: string
}

/** A {@link LinkedTarget} read from an address, with the workspace that address names. */
export interface HrefTarget extends LinkedTarget {
	/** The segment before the kind, or null when the address has none. */
	workspaceId: string | null
}

const BARE_URL = /https?:\/\/[^\s<>]+/gi
// What can trail an address in a sentence without belonging to it.
const URL_TAIL = /[.,;:!?)\]}'"]+$/
const APP_PATH = new RegExp(`^/([^/]+)/(objects|files|loops|triggers|agents)/(${UUID_SRC})/?$`, 'i')

const OWN_KIND: Record<
	string,
	Exclude<OwnSegment, { kind: 'text' | 'github' | 'settings' }>['kind']
> = {
	objects: 'object',
	files: 'file',
	loops: 'loop',
	triggers: 'trigger',
	agents: 'agent',
}

function isAppHost(host: string): boolean {
	const current = typeof window === 'undefined' ? '' : window.location.host
	return host === current || host === 'maskin.io' || host.endsWith('.maskin.io')
}

/** A GitHub pull request or issue, read from its address alone. Nothing is fetched. */
export interface GithubTarget {
	type: 'pull' | 'issue'
	repo: string
	number: number
}

const GITHUB_PATH = /^\/[\w.-]+\/([\w.-]+)\/(pull|issues)\/(\d+)\/?$/

/**
 * The settings sections a link can name, as the settings menu lists them. `path` is the segment
 * after `/settings` (empty for General, the page the bare settings address opens). `enterpriseOnly`
 * sections are in the settings menu only for enterprise workspaces, so elsewhere they stay plain links.
 */
export const SETTINGS_SECTIONS = [
	{ path: '', label: 'General' },
	{ path: 'objects', label: 'Objects' },
	{ path: 'members', label: 'Members' },
	{ path: 'integrations', label: 'Integrations' },
	{ path: 'extensions', label: 'Extensions' },
	{ path: 'skills', label: 'Skills' },
	{ path: 'mcp', label: 'MCP' },
	{ path: 'billing', label: 'Billing' },
	{ path: 'keychain', label: 'Keychain' },
	{ path: 'keys', label: 'Keys', enterpriseOnly: true },
] as const

/** A link to a settings page of this workspace, read from its address alone. Nothing is fetched. */
export type SettingsTarget = (typeof SETTINGS_SECTIONS)[number]

function isEnterpriseOnly(section: SettingsTarget): boolean {
	return 'enterpriseOnly' in section
}

const SETTINGS_PATH = /^\/([^/]+)\/settings(?:\/([^/]+))?\/?$/i
// Stands in for the host of an address that has none, so `new URL` accepts it.
const NO_HOST = 'no-host.invalid'

/**
 * The settings page an address in this workspace points at: `/{workspaceId}/settings` or
 * `/{workspaceId}/settings/{section}` for a section of the settings menu, on this app's host or
 * with no host. An unknown section, a deeper path, another workspace, any other site and an
 * enterprise-only section (Keys) in a workspace that is not enterprise is null and stays a plain link.
 */
export function settingsTargetOf(
	href: unknown,
	workspaceId: string,
	enterprise = false,
): SettingsTarget | null {
	if (typeof href !== 'string') return null
	let url: URL
	try {
		url = new URL(href, `http://${NO_HOST}`)
	} catch {
		return null
	}
	if (url.host !== NO_HOST && !isAppHost(url.host)) return null
	const match = SETTINGS_PATH.exec(url.pathname)
	if (!match || match[1].toLowerCase() !== workspaceId.toLowerCase()) return null
	const path = (match[2] ?? '').toLowerCase()
	const section = SETTINGS_SECTIONS.find((s) => s.path === path)
	return section && (enterprise || !isEnterpriseOnly(section)) ? section : null
}

/** What a settings chip reads, and its accessible name. */
export function settingsChipText(target: SettingsTarget): string {
	return `Settings: ${target.label}`
}

/**
 * The pull request or issue an address points at: exactly github.com (not a lookalike or a
 * subdomain), then `/{owner}/{repo}/pull/{n}` or `/{owner}/{repo}/issues/{n}`. A sub-path (files,
 * commits, checks), any other github.com address and any other site is null and stays a plain link.
 */
export function githubTargetOf(href: unknown): GithubTarget | null {
	if (typeof href !== 'string') return null
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.host !== 'github.com') {
		return null
	}
	if (url.username || url.password) return null
	const match = GITHUB_PATH.exec(url.pathname)
	if (!match) return null
	return { type: match[2] === 'pull' ? 'pull' : 'issue', repo: match[1], number: Number(match[3]) }
}

/**
 * One run of a message you wrote: words, a link to an object, file, loop, trigger or agent in this
 * workspace, a settings page, or a GitHub pull request or issue.
 */
export type OwnSegment =
	| { kind: 'text'; text: string }
	| { kind: 'object' | 'file' | 'loop' | 'trigger' | 'agent'; id: string }
	| { kind: 'github'; href: string; target: GithubTarget }
	| { kind: 'settings'; target: SettingsTarget }

/**
 * Your own message as an ordered run of words and links to this workspace's objects, files, loops, triggers and agents,
 * so each link can be drawn inline as a chip with the thing's name instead of a long address.
 * Your own text is plain (not markdown), so only bare addresses count. Any other address, and
 * the punctuation that trails one, stays in the words.
 */
export function splitOwnLinks(
	content: string,
	workspaceId: string,
	enterprise = false,
): OwnSegment[] {
	const segments: OwnSegment[] = []
	let cursor = 0
	const pushText = (text: string) => {
		if (!text) return
		const last = segments[segments.length - 1]
		if (last?.kind === 'text') last.text += text
		else segments.push({ kind: 'text', text })
	}
	for (const m of content.matchAll(BARE_URL)) {
		const raw = m[0]
		const tail = URL_TAIL.exec(raw)?.[0] ?? ''
		const address = tail ? raw.slice(0, -tail.length) : raw
		let url: URL
		try {
			url = new URL(address)
		} catch {
			continue
		}
		const github = githubTargetOf(address)
		if (github) {
			pushText(content.slice(cursor, m.index ?? 0))
			segments.push({ kind: 'github', href: address, target: github })
			cursor = (m.index ?? 0) + address.length
			continue
		}
		const settings = settingsTargetOf(address, workspaceId, enterprise)
		if (settings) {
			pushText(content.slice(cursor, m.index ?? 0))
			segments.push({ kind: 'settings', target: settings })
			cursor = (m.index ?? 0) + address.length
			continue
		}
		const match = APP_PATH.exec(url.pathname)
		if (!match || !isAppHost(url.host) || match[1].toLowerCase() !== workspaceId.toLowerCase()) {
			continue
		}
		const at = m.index ?? 0
		pushText(content.slice(cursor, at))
		segments.push({ kind: OWN_KIND[match[2].toLowerCase()], id: match[3].toLowerCase() })
		cursor = at + address.length
	}
	pushText(content.slice(cursor))
	return segments
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

const UUID = UUID_SRC
// Each kind's address: an optional workspace segment, then the kind and the id.
const hrefOf = (segment: string) =>
	new RegExp(`(?:/([^/?#]+))?/${segment}/(${UUID})(?:[/?#]|$)`, 'i')
// In the order they are tried when an address holds more than one.
const HREF_KINDS: [HrefTarget['kind'], RegExp][] = [
	['object', hrefOf('objects')],
	['file', hrefOf('files')],
	['loop', hrefOf('loops')],
	['trigger', hrefOf('triggers')],
	['agent', hrefOf('agents')],
]

/**
 * The object, file, loop, trigger or agent a link's address points at, if it points at one, with the
 * workspace the address names (null when it names none). Later kinds are added to the list above.
 */
export function targetOfHref(href: unknown): HrefTarget | null {
	if (typeof href !== 'string') return null
	for (const [kind, pattern] of HREF_KINDS) {
		const match = pattern.exec(href)
		if (match) {
			return { kind, id: match[2].toLowerCase(), workspaceId: match[1]?.toLowerCase() ?? null }
		}
	}
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

/** A paragraph that is only a link, as `placeLinkedCards` records it on the node. */
export interface StandaloneCard {
	target: LinkedTarget
	/** The short lead-in ("Draft:") that stood before the link; the renderer decides whether it stays. */
	label: string | null
	/** The paragraph was made from a tight list item's loose text; it has no `<p>` of its own. */
	bare: boolean
	/** The link stood in a list item. Only a draft gets a card there; any other object stays a chip. */
	inList: boolean
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

const isBlank = (node: HastNode) => node.type === 'text' && !node.value?.trim()

const MAX_PLACED_PER_KIND = 3
/** Cards for objects in plain paragraphs, per message. The fourth link on its own line is a chip. */
const MAX_OBJECT_CARDS = 3
/** Objects a message may make the app fetch. A link beyond that stays the plain link. */
const MAX_OBJECT_FETCHES = 10

/** Every object or file a link under these nodes points at, in order, without repeats. */
function linksIn(nodes: HastNode[]): LinkedTarget[] {
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
	for (const node of nodes) visit(node)
	return found
}

/** A paragraph's content as lines: a soft break (a `<br>` or a newline in the text) ends a line. */
function linesOf(nodes: HastNode[]): HastNode[][] {
	const lines: HastNode[][] = [[]]
	for (const node of nodes) {
		if (node.tagName === 'br') {
			lines.push([])
		} else if (node.type === 'text' && node.value?.includes('\n')) {
			node.value.split('\n').forEach((piece, i) => {
				if (i > 0) lines.push([])
				if (piece) lines[lines.length - 1].push({ type: 'text', value: piece })
			})
		} else {
			lines[lines.length - 1].push(node)
		}
	}
	return lines.filter((line) => !line.every(isBlank))
}

/** Objects, loops, triggers and agents: what the app looks up for a link, as against a file. */
const isLookedUp = (t: LinkedTarget) => t.kind !== 'file'

/** The tag of the element `placeLinkedCards` inserts for drafts and files linked inside a sentence. */
export const LINKED_CARDS_TAG = 'linked-cards'

/**
 * Decides, once and in reading order, where each linked object and file is drawn, and records it
 * in the rendered tree so the renderer cannot disagree:
 * - A paragraph that is nothing but a link, or a line of a paragraph that is (a sentence, the
 *   link on its own line, a sentence), is replaced by the card in place (the node gets
 *   `data.linkedCard`, a {@link StandaloneCard}). A list item that is nothing but a link does
 *   the same, keeping its short label as text; there only a draft becomes a card.
 * - Every other link to an object (in a sentence, a heading, a quote, a table or a list) is
 *   drawn as a chip where it stands: the link gets `data.linkedChip`. A draft keeps its link
 *   and gets its approval card right after the paragraph, heading, quote, table or list item
 *   that holds it (a `linked-cards` element), as before; only the renderer can tell a draft, so
 *   the element lists every object that might need one and drops the ones drawn in place.
 * - A file linked inside a sentence gets its card there too.
 * An object gets a card in place at most three times per message, and not at all when `skipIds`
 * holds it (an earlier message in the chat already shows it) or it is already drawn: that link is
 * then a chip. Only the first ten objects a message links to are looked up; later links stay
 * plain links. Whether an object or file deserves a card at all is the renderer's call; until it
 * says yes the link shows. Loose, tight, nested and ordered lists all follow the same rules.
 */
export function placeLinkedCards(tree: HastNode, skipIds?: ReadonlySet<string>): void {
	const drawn = new Set<string>()
	const placed = { object: 0, file: 0 }
	const trailed = new Set<string>()
	const trailing: HastNode[] = []
	const key = (t: LinkedTarget) => `${t.kind}:${t.id}`
	// Loops and triggers cost no request of their own (they read shared lists), but they count
	// toward the same caps as objects so there is one rule.
	const fetchable = new Set(
		linksIn(tree.children ?? [])
			.filter(isLookedUp)
			.slice(0, MAX_OBJECT_FETCHES)
			.map(key),
	)
	const available = (t: LinkedTarget) =>
		!drawn.has(key(t)) && !skipIds?.has(t.id) && (t.kind === 'file' || fetchable.has(key(t)))
	// Whether a link standing alone may be replaced by its card here.
	const cardable = (t: LinkedTarget, inList: boolean) =>
		available(t) && (inList || t.kind === 'file' || placed.object < MAX_OBJECT_CARDS)

	// The cards for objects and files linked in `nodes` that nothing has drawn yet, as one element
	// to insert after.
	const cardsAfter = (nodes: HastNode[]): HastNode[] => {
		const links = linksIn(nodes)
		const objects = links.filter((t) => {
			if (t.kind !== 'object' || !available(t) || trailed.has(t.id)) return false
			if (trailed.size >= MAX_OBJECT_CARDS) return false
			trailed.add(t.id)
			return true
		})
		const files = links.filter((t) => {
			if (t.kind !== 'file' || !available(t) || placed.file >= MAX_PLACED_PER_KIND) return false
			placed.file += 1
			drawn.add(key(t))
			return true
		})
		if (objects.length + files.length === 0) return []
		const element: HastNode = {
			type: 'element',
			tagName: LINKED_CARDS_TAG,
			properties: {
				objects: objects.map((t) => t.id).join(','),
				files: files.map((t) => t.id).join(','),
			},
			children: [],
		}
		trailing.push(element)
		return [element]
	}

	const markCard = (node: HastNode, card: StandaloneCard) => {
		node.data = { ...node.data, linkedCard: card }
		drawn.add(key(card.target))
		if (!card.inList && isLookedUp(card.target)) placed.object += 1
	}

	const paragraph = (children: HastNode[]): HastNode => ({
		type: 'element',
		tagName: 'p',
		properties: {},
		children,
	})

	// A paragraph with a link alone on one of its lines becomes: the lines before, the card, the
	// lines after. Null when no line qualifies, and then nothing has been touched.
	const splitAtCards = (lines: HastNode[][]): HastNode[] | null => {
		const pieces: HastNode[] = []
		let run: HastNode[][] = []
		let found = false
		const flush = () => {
			if (run.length === 0) return
			const br = (): HastNode => ({ type: 'element', tagName: 'br', properties: {}, children: [] })
			pieces.push(paragraph(run.flatMap((line, i) => (i === 0 ? line : [br(), ...line]))))
			run = []
		}
		for (const line of lines) {
			const probe = paragraph(line)
			const hit = standaloneLink(probe, { allowLabel: true })
			if (hit && cardable(hit.target, false)) {
				flush()
				markCard(probe, { ...hit, bare: false, inList: false })
				pieces.push(probe)
				found = true
			} else {
				run.push(line)
			}
		}
		flush()
		return found ? pieces : null
	}

	const placeParagraph = (p: HastNode, inItem: boolean): HastNode[] => {
		const hit = standaloneLink(p, { allowLabel: true })
		if (hit && cardable(hit.target, inItem)) {
			markCard(p, { ...hit, bare: false, inList: inItem })
			return [p]
		}
		if (!inItem) {
			const lines = linesOf(p.children ?? [])
			const pieces = lines.length > 1 ? splitAtCards(lines) : null
			if (pieces) return [...pieces, ...cardsAfter(pieces)]
		}
		return [p, ...cardsAfter([p])]
	}

	const processContainer = (container: HastNode, inItem: boolean) => {
		const out: HastNode[] = []
		const children = container.children ?? []
		let at = 0
		while (at < children.length) {
			const child = children[at]
			const isBlock = child.tagName !== undefined && BLOCK_TAGS.has(child.tagName)
			if (!isBlock && inItem) {
				// A tight list item's own text: everything up to the first nested block.
				let end = at
				while (
					end < children.length &&
					!(children[end].tagName !== undefined && BLOCK_TAGS.has(children[end].tagName as string))
				) {
					end += 1
				}
				const run = children.slice(at, end)
				at = end
				if (run.every(isBlank)) {
					out.push(...run)
					continue
				}
				const probe = paragraph(run)
				const hit = standaloneLink(probe, { allowLabel: true })
				if (hit && cardable(hit.target, true)) {
					markCard(probe, { ...hit, bare: true, inList: true })
					out.push(probe)
				} else {
					out.push(...run, ...cardsAfter(run))
				}
				continue
			}
			at += 1
			if (child.tagName === 'p') {
				out.push(...placeParagraph(child, inItem))
			} else if (child.tagName === 'ul' || child.tagName === 'ol') {
				for (const item of child.children ?? []) {
					if (item.tagName === 'li') processContainer(item, true)
				}
				out.push(child)
			} else {
				// A heading, quote, table or anything else: its links keep their place in the text.
				out.push(child, ...cardsAfter([child]))
			}
		}
		container.children = out
	}
	processContainer(tree, false)

	// An object drawn in place further down is not drawn again under the sentence that mentions it.
	for (const element of trailing) {
		const ids = String(element.properties?.objects ?? '')
			.split(',')
			.filter((id) => id && !drawn.has(`object:${id}`))
		element.properties = { ...element.properties, objects: ids.join(',') }
	}

	// The drafts a card is still drawn for under their sentence. The card follows the first link to
	// each; a later link to the same id, or a link past the card cap, has no card.
	const followed = new Set(
		trailing.flatMap((element) =>
			String(element.properties?.objects ?? '')
				.split(',')
				.filter(Boolean),
		),
	)
	const seen = new Set<string>()

	// Every link to an object that is not replaced by a card is a chip where it stands. A draft
	// keeps its plain link only when its card follows; otherwise it is a chip like any object.
	const markChips = (node: HastNode) => {
		if (node.tagName === 'a') {
			const target = targetOfHref(node.properties?.href)
			if (target && isLookedUp(target) && fetchable.has(key(target))) {
				const first = !seen.has(key(target))
				seen.add(key(target))
				node.data = {
					...node.data,
					linkedChip: true,
					cardFollows: target.kind === 'object' && first && followed.has(target.id),
				}
			}
		}
		for (const child of node.children ?? []) markChips(child)
	}
	markChips(tree)
}

const MAX_SNIPPET_LENGTH = 280

/**
 * The first lines of an object's text as plain words, for the muted row on a card: headings,
 * list markers, emphasis, links, code fences and table borders are removed, the lines are joined
 * with spaces and the result is cut at a length the card can clamp to two lines.
 */
export function plainSnippet(content: string | null | undefined): string {
	if (!content) return ''
	const text = content
		.replace(FENCED_CODE, '$1')
		.split('\n')
		.map((line) =>
			line
				.replace(/^\s*(?:#{1,6}\s+|>+\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
				.replace(/^\s*(?:[-*_]\s*){3,}$/, '')
				.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/[*_~`]+/g, '')
				.replace(/\|/g, ' ')
				.replace(/^\s*:?-{3,}:?\s*$/, '')
				.trim(),
		)
		.filter(Boolean)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}…` : text
}

/** The longest a name on an inline chip runs before it is cut with an ellipsis. */
export const CHIP_MAX_LENGTH = 90
// A cut that falls on a word keeps the word whole only when it leaves most of the name.
const CHIP_MIN_WORD_CUT = 60

/**
 * The part of a title a chip shows: the text before the first space, long dash and space ("David
 * Harboe — Norlix (CTO)" reads "David Harboe"). A title without that shows whole. Only the chip
 * uses it; the card, the preview and the accessible name carry the full title.
 */
export function shortName(title: string): string {
	const dash = title.indexOf(' — ')
	return dash > 0 ? title.slice(0, dash).trimEnd() : title
}

/**
 * A name longer than `CHIP_MAX_LENGTH` cut at the last space before that length when the space is
 * past character 60, else at the length itself, and ended with an ellipsis.
 */
export function cutLabel(name: string): string {
	if (name.length <= CHIP_MAX_LENGTH) return name
	const head = name.slice(0, CHIP_MAX_LENGTH)
	const space = head.lastIndexOf(' ')
	return `${head.slice(0, space > CHIP_MIN_WORD_CUT ? space : CHIP_MAX_LENGTH).trimEnd()}…`
}

/** A labelled row on a card: a field the record really holds. */
export interface CardFact {
	label: string
	value: string
}

/** The most fact rows a card shows. */
export const MAX_CARD_FACTS = 3
// Fields the card already shows elsewhere, so they are never a fact row.
const FACT_SKIPPED = new Set(['title', 'status', 'text', 'driver'])

function factText(value: unknown): string {
	if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (Array.isArray(value)) return value.map(factText).filter(Boolean).join(', ')
	return ''
}

/** A field name or enum value as plain words with a capital: "moves_the_bar" is "Moves the bar". */
export function plainWords(raw: string): string {
	const words = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}

// A link or a git ref is not a fact to read at a glance, the card itself is the way in.
const LINK_FIELD_NAME = /(^|[\s_-])(url|link|branch)$/i
const LINK_VALUE = /^https?:\/\//i

/**
 * The fact rows of an object card: up to three fields of the type's field list that the record
 * has filled in, in the list's order, leaving out title, status, text and driver. Label is the
 * field's name in plain words and value its text on one line (an enum value in plain words too).
 * A link field, by its name or by a value that is a web address, is left out. An empty field is
 * left out, so a record with none filled gets no rows.
 */
export function pickFacts(
	fields: ReadonlyArray<{ name: string; type?: string }> | null | undefined,
	metadata: Record<string, unknown> | null | undefined,
): CardFact[] {
	const facts: CardFact[] = []
	for (const field of fields ?? []) {
		if (facts.length >= MAX_CARD_FACTS) break
		if (FACT_SKIPPED.has(field.name.toLowerCase()) || LINK_FIELD_NAME.test(field.name)) continue
		const text = factText(metadata?.[field.name])
		if (!text || LINK_VALUE.test(text)) continue
		facts.push({
			label: plainWords(field.name),
			value: field.type === 'enum' ? plainWords(text) : text,
		})
	}
	return facts
}

/**
 * The words for something that cannot be drawn, on a card and on a chip. `kind` is the noun
 * ("object"). The lookup cannot tell a deleted thing from one you may not see, so it is always
 * "deleted".
 */
export function unavailableCopy(kind: string): { card: string; chip: string } {
	return { card: `This ${kind} was deleted`, chip: `Deleted ${kind}` }
}

/** What a GitHub chip reads: the repository's name (not its owner) and the number. */
export function githubChipText(target: GithubTarget): string {
	return `${target.repo} #${target.number}`
}

/** The accessible name of a GitHub chip: it says it leaves the app. */
export function githubChipName(target: GithubTarget): string {
	return `${target.type === 'pull' ? 'Pull request' : 'Issue'} ${githubChipText(target)}, opens GitHub`
}
