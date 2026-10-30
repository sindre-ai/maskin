import {
	CHIP_MAX_LENGTH,
	chatSummary,
	cutLabel,
	extractLinkedFileIds,
	extractLinkedObjectIds,
	githubChipName,
	githubChipText,
	githubTargetOf,
	isOtherWorkspace,
	peopleLine,
	pickFacts,
	plainPreview,
	plainSnippet,
	settingsChipText,
	settingsTargetOf,
	shortName,
	showsObjectCard,
	splitOwnLinks,
	targetOfHref,
	unavailableCopy,
} from '@/lib/linked-objects'
import { describe, expect, it } from 'vitest'

const WS = 'e2877e32-2c11-489e-96c8-a76200908ed4'
const A = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const B = '4aee24db-5d54-476a-8399-9586516e7de1'
const C = '3ecab143-9e98-4474-9e52-779a55d95952'
const D = '024bc0a4-1111-4222-8333-444455556666'

describe('extractLinkedObjectIds', () => {
	it('returns the ids of object links in order of appearance', () => {
		const text = `See [note](https://maskin.io/ws/objects/${A}) and /ws/objects/${B}.`
		expect(extractLinkedObjectIds(text)).toEqual([A, B])
	})

	it('lists an object once however often it is linked', () => {
		expect(extractLinkedObjectIds(`/objects/${A} then /objects/${A.toUpperCase()}`)).toEqual([A])
	})

	it('stops at the maximum', () => {
		const text = [A, B, C, D].map((id) => `/objects/${id}`).join(' ')
		expect(extractLinkedObjectIds(text, 3)).toEqual([A, B, C])
	})

	it('ignores ids that are not object links', () => {
		expect(extractLinkedObjectIds(`session ${A} and /agents/${B}`)).toEqual([])
	})
})

describe('extractLinkedFileIds', () => {
	it('returns the ids of file links in order of appearance', () => {
		const text = `Page https://maskin.io/ws/files/${A} and the image /ws/files/${B}.`
		expect(extractLinkedFileIds(text)).toEqual([A, B])
	})

	it('lists a file once however often it is linked', () => {
		expect(extractLinkedFileIds(`/files/${A} then /files/${A.toUpperCase()}`)).toEqual([A])
	})

	it('stops at the maximum', () => {
		const text = [A, B, C, D].map((id) => `/files/${id}`).join(' ')
		expect(extractLinkedFileIds(text, 3)).toEqual([A, B, C])
	})

	it('does not take an object link for a file link, or the other way round', () => {
		expect(extractLinkedFileIds(`/objects/${A}`)).toEqual([])
		expect(extractLinkedObjectIds(`/files/${A}`)).toEqual([])
	})

	it('returns nothing for text without links', () => {
		expect(extractLinkedFileIds('no links here')).toEqual([])
	})
})

describe('showsObjectCard', () => {
	const draft = { workspaceId: 'ws', content: 'Hej', preview: { body: 'Hej' } }

	it('is true for a draft with text in this workspace', () => {
		expect(showsObjectCard(draft, 'ws')).toBe(true)
	})

	it('is false for a plain task, another workspace, no text, or no object', () => {
		expect(showsObjectCard({ ...draft, preview: null }, 'ws')).toBe(false)
		expect(showsObjectCard(draft, 'other')).toBe(false)
		expect(showsObjectCard({ ...draft, content: '  ' }, 'ws')).toBe(false)
		expect(showsObjectCard(undefined, 'ws')).toBe(false)
	})
})

describe('targetOfHref', () => {
	const id = 'a7167fde-3f84-42ce-800d-2ba2362944ea'

	it('reads an object or file id from an address', () => {
		expect(targetOfHref(`https://x.io/ws/objects/${id.toUpperCase()}`)).toEqual({
			kind: 'object',
			id,
			workspaceId: 'ws',
		})
		expect(targetOfHref(`/ws/files/${id}`)).toEqual({ kind: 'file', id, workspaceId: 'ws' })
	})

	it('reads a loop or trigger id from an address', () => {
		expect(targetOfHref(`https://x.io/ws/loops/${id.toUpperCase()}`)).toEqual({
			kind: 'loop',
			id,
			workspaceId: 'ws',
		})
		expect(targetOfHref(`/ws/triggers/${id}?tab=x`)).toEqual({
			kind: 'trigger',
			id,
			workspaceId: 'ws',
		})
	})

	it('reads an agent id from an address, in any case and with a query', () => {
		expect(targetOfHref(`https://x.io/ws/agents/${id.toUpperCase()}?tab=x`)).toEqual({
			kind: 'agent',
			id,
			workspaceId: 'ws',
		})
	})

	it('returns the workspace the address names, for this workspace and for another', () => {
		const here = 'e2877e32-2c11-489e-96c8-a76200908ed4'
		const other = '11111111-2222-4333-8444-555555555555'
		for (const kind of ['objects', 'files', 'loops', 'triggers', 'agents', 'chats']) {
			const inHere = targetOfHref(`https://maskin.io/${here}/${kind}/${id}`)
			const inOther = targetOfHref(`https://maskin.io/${other.toUpperCase()}/${kind}/${id}#x`)
			expect(inHere?.workspaceId).toBe(here)
			expect(inOther?.workspaceId).toBe(other)
		}
	})

	it('reads a chat address, and the workspace it names', () => {
		const other = '11111111-2222-4333-8444-555555555555'
		expect(targetOfHref(`https://maskin.io/ws/chats/${id.toUpperCase()}`)).toEqual({
			kind: 'chat',
			id,
			workspaceId: 'ws',
		})
		expect(targetOfHref(`/${other}/chats/${id}?thread=7#top`)).toEqual({
			kind: 'chat',
			id,
			workspaceId: other,
		})
	})

	it('leaves the chat list, a new chat and a chat id that is not an id as plain links', () => {
		expect(targetOfHref('/ws/chats')).toBeNull()
		expect(targetOfHref('/ws/chats/new')).toBeNull()
		expect(targetOfHref(`/ws/chats/${id}x`)).toBeNull()
	})

	it('returns no workspace for an address that names none', () => {
		expect(targetOfHref(`/objects/${id}`)).toEqual({ kind: 'object', id, workspaceId: null })
	})

	it('ignores a loop or trigger address with more id characters after the id', () => {
		expect(targetOfHref(`/ws/loops/${id}x`)).toBeNull()
		expect(targetOfHref('/ws/loops')).toBeNull()
	})

	it('ignores an agents address without an id, or with more id characters after it', () => {
		expect(targetOfHref(`/ws/agents/${id}x`)).toBeNull()
	})

	it('ignores any other address', () => {
		expect(targetOfHref('https://x.io/ws/agents')).toBeNull()
		expect(targetOfHref(undefined)).toBeNull()
	})
})

describe('extractLinkedObjectIds / extractLinkedFileIds in code and with boundaries', () => {
	it('ignores addresses in inline code and fenced blocks', () => {
		const text = `Use \`/ws/objects/${A}\`.\n\n\`\`\`\n/ws/objects/${B}\n/ws/files/${C}\n\`\`\`\n\nReal: /ws/objects/${D}`
		expect(extractLinkedObjectIds(text)).toEqual([D])
		expect(extractLinkedFileIds(text)).toEqual([])
	})

	it('needs the id to end where an address ends', () => {
		expect(extractLinkedObjectIds(`/ws/objects/${A}x`)).toEqual([])
		expect(extractLinkedObjectIds(`/ws/objects/${A}-more`)).toEqual([])
		expect(
			extractLinkedObjectIds(`(/ws/objects/${A}), /ws/objects/${B}?x=1 /ws/objects/${C}/`),
		).toEqual([A, B, C])
	})
})

describe('splitOwnLinks', () => {
	const url = (kind: string, id: string) => `https://maskin.io/${WS}/${kind}/${id}`

	it('keeps the words and the link in the order they were written', () => {
		expect(splitOwnLinks(`is this done? ${url('objects', A)} thanks`, WS)).toEqual([
			{ kind: 'text', text: 'is this done? ' },
			{ kind: 'object', id: A },
			{ kind: 'text', text: ' thanks' },
		])
	})

	it('finds a link to a file and leaves the sentence punctuation in the words', () => {
		expect(splitOwnLinks(`see ${url('files', B)}.`, WS)).toEqual([
			{ kind: 'text', text: 'see ' },
			{ kind: 'file', id: B },
			{ kind: 'text', text: '.' },
		])
	})

	it('is just the link when the message is only the link', () => {
		expect(splitOwnLinks(url('objects', A), WS)).toEqual([{ kind: 'object', id: A }])
	})

	it('keeps every link, including a repeated one', () => {
		const link = url('objects', A)
		expect(splitOwnLinks(`${link} ${link}`, WS).filter((s) => s.kind === 'object')).toHaveLength(2)
	})

	it('finds a bare address of a loop and of a trigger', () => {
		expect(splitOwnLinks(`${url('loops', A)} wakes ${url('triggers', B)}`, WS)).toEqual([
			{ kind: 'loop', id: A },
			{ kind: 'text', text: ' wakes ' },
			{ kind: 'trigger', id: B },
		])
	})

	it('finds a bare address of an agent', () => {
		expect(splitOwnLinks(`ask ${url('agents', A)} to look`, WS)).toEqual([
			{ kind: 'text', text: 'ask ' },
			{ kind: 'agent', id: A },
			{ kind: 'text', text: ' to look' },
		])
	})

	it('marks an agent address of another workspace with that workspace', () => {
		const other = `https://maskin.io/${A}/agents/${B}`
		expect(splitOwnLinks(other, WS)).toEqual([{ kind: 'agent', id: B, otherWorkspaceId: A }])
	})

	it('marks an object, loop, trigger or chat address of another workspace with that workspace', () => {
		for (const kind of ['objects', 'loops', 'triggers', 'chats']) {
			const other = `https://maskin.io/${A.toUpperCase()}/${kind}/${B}`
			expect(splitOwnLinks(other, WS)).toEqual([
				{ kind: kind.slice(0, -1), id: B, otherWorkspaceId: A },
			])
		}
	})

	it('finds a settings address in your own message, alone or in a sentence', () => {
		const settings = `https://maskin.io/${WS}/settings/billing`
		expect(splitOwnLinks(settings, WS)).toEqual([
			{ kind: 'settings', target: { path: 'billing', label: 'Billing' } },
		])
		expect(splitOwnLinks(`open ${settings}, then pay`, WS)).toEqual([
			{ kind: 'text', text: 'open ' },
			{ kind: 'settings', target: { path: 'billing', label: 'Billing' } },
			{ kind: 'text', text: ', then pay' },
		])
	})

	it('draws a Keys address in your own message as a chip only in an enterprise workspace', () => {
		const keys = `https://maskin.io/${WS}/settings/keys`
		expect(splitOwnLinks(keys, WS, true)).toEqual([
			{ kind: 'settings', target: { path: 'keys', label: 'Keys', enterpriseOnly: true } },
		])
		expect(splitOwnLinks(keys, WS, false)).toEqual([{ kind: 'text', text: keys }])
		expect(splitOwnLinks(keys, WS)).toEqual([{ kind: 'text', text: keys }])
	})

	it('leaves an unknown settings section, a deeper one and another workspace as words', () => {
		for (const text of [
			`https://maskin.io/${WS}/settings/nope`,
			`https://maskin.io/${WS}/settings/keychain/new`,
			`https://maskin.io/${A}/settings/mcp`,
		]) {
			expect(splitOwnLinks(text, WS)).toEqual([{ kind: 'text', text }])
		}
	})

	it('finds a bare address of a chat', () => {
		expect(splitOwnLinks(`see ${url('chats', A)}.`, WS)).toEqual([
			{ kind: 'text', text: 'see ' },
			{ kind: 'chat', id: A },
			{ kind: 'text', text: '.' },
		])
	})

	it('leaves a file of another workspace, another site or a non-object page as words', () => {
		const otherFile = `https://maskin.io/${A}/files/${B}`
		const notAWorkspace = `https://maskin.io/settings/objects/${B}`
		const elsewhere = `https://example.com/${WS}/objects/${A}`
		const elsewhereOther = `https://example.com/${A}/objects/${B}`
		const page = url('sessions', A)
		for (const text of [
			otherFile,
			notAWorkspace,
			elsewhere,
			elsewhereOther,
			page,
			'no links here',
		]) {
			expect(splitOwnLinks(text, WS)).toEqual([{ kind: 'text', text }])
		}
	})
})

describe('githubTargetOf', () => {
	it('reads a pull request and an issue from the address alone', () => {
		expect(githubTargetOf('https://github.com/sindre-ai/maskin/pull/2637')).toEqual({
			type: 'pull',
			repo: 'maskin',
			number: 2637,
		})
		expect(githubTargetOf('https://github.com/sindre-ai/maskin/issues/12')).toEqual({
			type: 'issue',
			repo: 'maskin',
			number: 12,
		})
	})

	it('reads another owner and repo, a trailing slash, a query and a fragment', () => {
		expect(githubTargetOf('https://github.com/vaerksted-ai/skjald.app/pull/7/')).toEqual({
			type: 'pull',
			repo: 'skjald.app',
			number: 7,
		})
		expect(githubTargetOf('https://github.com/a/b/issues/3?x=1#issuecomment-9')?.number).toBe(3)
	})

	it('leaves a sub-path and any other github.com address as a plain link', () => {
		for (const href of [
			'https://github.com/sindre-ai/maskin/pull/2637/files',
			'https://github.com/sindre-ai/maskin/pull/2637/commits',
			'https://github.com/sindre-ai/maskin/issues/12/checks',
			'https://github.com/sindre-ai/maskin/commit/5d8bd50',
			'https://github.com/sindre-ai/maskin/tree/main',
			'https://github.com/sindre-ai/maskin/pulls',
			'https://github.com/sindre-ai/maskin/pull/abc',
			'https://github.com/sindre-ai/maskin',
			'https://github.com/sindre-ai',
		]) {
			expect(githubTargetOf(href)).toBeNull()
		}
	})

	it('only counts the exact host github.com', () => {
		for (const href of [
			'https://github.com.evil.com/a/b/pull/1',
			'https://evilgithub.com/a/b/pull/1',
			'https://gist.github.com/a/b/pull/1',
			'https://www.github.com/a/b/pull/1',
			'https://github.com@evil.com/a/b/pull/1',
			'https://github.com:8443/a/b/pull/1',
			'https://user@github.com/a/b/pull/1',
			'https://user:secret@github.com/a/b/pull/1',
			'https://gitlab.com/a/b/pull/1',
			'ftp://github.com/a/b/pull/1',
			'/a/b/pull/1',
			'not an address',
		]) {
			expect(githubTargetOf(href)).toBeNull()
		}
		expect(githubTargetOf(undefined)).toBeNull()
	})

	it('names the chip by repository and number, and says it opens GitHub', () => {
		const pull = githubTargetOf('https://github.com/sindre-ai/maskin/pull/2637')
		const issue = githubTargetOf('https://github.com/sindre-ai/maskin/issues/12')
		if (!pull || !issue) throw new Error('expected both to read')
		expect(githubChipText(pull)).toBe('maskin #2637')
		expect(githubChipName(pull)).toBe('Pull request maskin #2637, opens GitHub')
		expect(githubChipName(issue)).toBe('Issue maskin #12, opens GitHub')
	})
})

describe('splitOwnLinks with GitHub addresses', () => {
	const pr = 'https://github.com/sindre-ai/maskin/pull/2637'

	it('makes a bare pull request or issue address a segment, keeping the words around it', () => {
		expect(splitOwnLinks(`review ${pr}, then https://github.com/a/b/issues/4.`, WS)).toEqual([
			{ kind: 'text', text: 'review ' },
			{ kind: 'github', href: pr, target: { type: 'pull', repo: 'maskin', number: 2637 } },
			{ kind: 'text', text: ', then ' },
			{
				kind: 'github',
				href: 'https://github.com/a/b/issues/4',
				target: { type: 'issue', repo: 'b', number: 4 },
			},
			{ kind: 'text', text: '.' },
		])
	})

	it('leaves a sub-path and a lookalike host as words', () => {
		for (const text of [`${pr}/files`, 'https://github.com.evil.com/a/b/pull/1']) {
			expect(splitOwnLinks(text, WS)).toEqual([{ kind: 'text', text }])
		}
	})
})

describe('settingsTargetOf', () => {
	const at = (path: string, host = 'https://maskin.io') => `${host}/${WS}/settings${path}`

	it('reads the bare settings address as General', () => {
		for (const href of [at(''), at('/'), `/${WS}/settings`]) {
			expect(settingsTargetOf(href, WS)).toEqual({ path: '', label: 'General' })
		}
	})

	it('reads each section of the settings menu', () => {
		const sections = [
			['objects', 'Objects'],
			['members', 'Members'],
			['integrations', 'Integrations'],
			['extensions', 'Extensions'],
			['skills', 'Skills'],
			['mcp', 'MCP'],
			['billing', 'Billing'],
			['keychain', 'Keychain'],
		]
		for (const [path, label] of sections) {
			expect(settingsTargetOf(at(`/${path}`), WS)).toEqual({ path, label })
		}
		expect(settingsTargetOf(at('/mcp?tab=x#top'), WS)?.label).toBe('MCP')
	})

	it('reads Keys only in an enterprise workspace, as the settings menu shows it', () => {
		expect(settingsTargetOf(at('/keys'), WS, true)).toEqual({
			path: 'keys',
			label: 'Keys',
			enterpriseOnly: true,
		})
		expect(settingsTargetOf(at('/keys'), WS, false)).toBeNull()
		expect(settingsTargetOf(at('/keys'), WS)).toBeNull()
		// Every other section is the same either way.
		expect(settingsTargetOf(at('/billing'), WS, true)).toEqual({
			path: 'billing',
			label: 'Billing',
		})
	})

	it('leaves an unknown section, a deeper path and another page as plain links', () => {
		for (const href of [
			at('/nope'),
			at('/general'),
			at('/billing/invoices'),
			at('/keychain/new'),
			at('/objects/priority'),
			`https://maskin.io/${WS}/agents`,
		]) {
			expect(settingsTargetOf(href, WS)).toBeNull()
		}
	})

	it('leaves another workspace, another site and a non-address as plain links', () => {
		for (const href of [
			at('/mcp', 'https://example.com'),
			at('/mcp', 'https://maskin.io.evil.com'),
			`https://maskin.io/${A}/settings/mcp`,
			undefined,
			42,
		]) {
			expect(settingsTargetOf(href, WS)).toBeNull()
		}
	})

	it('words the chip as Settings and the section', () => {
		expect(settingsChipText({ path: 'mcp', label: 'MCP' })).toBe('Settings: MCP')
	})
})

describe('isOtherWorkspace', () => {
	const other = '11111111-2222-4333-8444-555555555555'

	it('is true for an object, loop, trigger, agent or chat whose address names a different workspace', () => {
		for (const kind of ['object', 'loop', 'trigger', 'agent', 'chat'] as const) {
			expect(isOtherWorkspace({ kind, id: A, workspaceId: other }, WS)).toBe(true)
		}
	})

	it('is false for this workspace in any letter case, and for an address that names none', () => {
		expect(isOtherWorkspace({ kind: 'object', id: A, workspaceId: WS.toUpperCase() }, WS)).toBe(
			false,
		)
		expect(isOtherWorkspace({ kind: 'object', id: A, workspaceId: null }, WS)).toBe(false)
		expect(isOtherWorkspace({ kind: 'object', id: A }, WS)).toBe(false)
	})

	it('is false for a file, for a segment that is not a workspace id and without a current workspace', () => {
		expect(isOtherWorkspace({ kind: 'file', id: A, workspaceId: other }, WS)).toBe(false)
		expect(isOtherWorkspace({ kind: 'object', id: A, workspaceId: 'settings' }, WS)).toBe(false)
		expect(isOtherWorkspace({ kind: 'object', id: A, workspaceId: other })).toBe(false)
	})
})

describe('plainSnippet', () => {
	it('turns markdown into plain words on one line', () => {
		expect(
			plainSnippet(
				'## Plan\n\n- Do **the thing**\n- See [the doc](https://x.test)\n\n```\ncode\n```',
			),
		).toBe('Plan Do the thing See the doc')
	})

	it('is empty for no text', () => {
		expect(plainSnippet(null)).toBe('')
		expect(plainSnippet('  \n ')).toBe('')
	})

	it('cuts a long text', () => {
		const out = plainSnippet('word '.repeat(200))
		expect(out.length).toBeLessThanOrEqual(281)
		expect(out.endsWith('…')).toBe(true)
	})
})

describe('plainPreview', () => {
	const words = (content: string | null) =>
		plainPreview(content)
			.map((part) => (part.muted ? `<${part.text}>` : part.text))
			.join('')

	it('shows a markdown link as its text', () => {
		expect(words('See [PR 2527](https://github.com/sindre-ai/maskin/pull/2527) now')).toBe(
			'See PR 2527 now',
		)
	})

	it('shows the text of a link cut off in the address', () => {
		expect(words('See [PR 2527](https://github.com/sindre-ai/maskin/pu')).toBe('See PR 2527')
		expect(words('See [PR 2527](')).toBe('See PR 2527')
	})

	it('shows the text of a link cut off in the text', () => {
		expect(words('See [PR 25')).toBe('See PR 25')
		expect(words('See [')).toBe('See')
	})

	it('shows a bare address as a muted "link", keeping the full stop after it', () => {
		expect(plainPreview('Merged, see https://maskin.io/ws/objects/abc.')).toEqual([
			{ text: 'Merged, see ' },
			{ text: 'link', muted: true },
			{ text: '.' },
		])
		expect(words('see <https://x.test/a_b_c> and https://x.test/d')).toBe('see <link> and <link>')
	})

	it('shows a bare address cut short as "link"', () => {
		expect(words('see https://maskin.io/e2877e32-2c11')).toBe('see <link>')
	})

	it('removes bold, italic, code, heading and list marks on one line', () => {
		expect(words('## Plan\n- Do **the** _thing_\n1. Run `pnpm test`')).toBe(
			'Plan Do the thing Run pnpm test',
		)
	})

	it('leaves a message with no links as it was', () => {
		expect(words('The retry window is still open on three accounts.')).toBe(
			'The retry window is still open on three accounts.',
		)
	})

	it('is empty for no text', () => {
		expect(plainPreview(null)).toEqual([])
		expect(plainPreview('')).toEqual([])
	})

	it('reads only the start of a long message and ends with an ellipsis', () => {
		const parts = plainPreview(`${'word '.repeat(200)}[tail](https://x.test)`)
		expect(parts.at(-1)).toEqual({ text: '…' })
		expect(words('word '.repeat(200)).length).toBeLessThan(450)
	})
})

describe('shortName', () => {
	it('keeps a title whole when it has no long dash', () => {
		expect(shortName('Audit open bet PRs for work merged into a bet branch')).toBe(
			'Audit open bet PRs for work merged into a bet branch',
		)
	})

	it('keeps the text before the first space, long dash and space', () => {
		expect(shortName('David Harboe \u2014 Norlix (CTO & Co-founder)')).toBe('David Harboe')
		expect(shortName('A \u2014 B \u2014 C')).toBe('A')
	})

	it('keeps a title whole when the long dash has no space around it', () => {
		expect(shortName('Norlix\u2014CTO')).toBe('Norlix\u2014CTO')
		expect(shortName('Norlix \u2014CTO')).toBe('Norlix \u2014CTO')
	})

	it('is empty for an empty title', () => {
		expect(shortName('')).toBe('')
	})
})

describe('cutLabel', () => {
	it('leaves a name of 90 characters or fewer alone', () => {
		const name = 'a'.repeat(CHIP_MAX_LENGTH)
		expect(cutLabel(name)).toBe(name)
		expect(cutLabel('')).toBe('')
	})

	it('cuts at the last space before character 90 when that space is past character 60', () => {
		const name = `${'word '.repeat(17)}${'x'.repeat(40)}`
		expect(cutLabel(name)).toBe(`${'word '.repeat(16)}word…`)
	})

	it('cuts at character 90 when there is no space past character 60', () => {
		const name = `short words ${'x'.repeat(120)}`
		expect(cutLabel(name)).toBe(`${name.slice(0, CHIP_MAX_LENGTH)}…`)
	})
})

describe('pickFacts', () => {
	const fields = [
		{ name: 'Title' },
		{ name: 'status' },
		{ name: 'priority' },
		{ name: 'text' },
		{ name: 'Driver' },
		{ name: 'Role' },
		{ name: 'Source' },
		{ name: 'Company' },
	]

	it('takes filled fields in the order of the field list and skips title, status, text and driver', () => {
		const metadata = {
			Company: 'Norlix',
			Role: 'CTO',
			priority: 'P1',
			title: 'x',
			status: 'active',
			text: 'y',
			driver: 'z',
		}
		expect(pickFacts(fields, metadata)).toEqual([
			{ label: 'Priority', value: 'P1' },
			{ label: 'Role', value: 'CTO' },
			{ label: 'Company', value: 'Norlix' },
		])
	})

	it('leaves out empty fields, and gives no rows when none is filled', () => {
		expect(pickFacts(fields, { priority: '  ', Role: '', Source: null, Company: [] })).toEqual([])
		expect(pickFacts(fields, { Source: 'Referral' })).toEqual([
			{ label: 'Source', value: 'Referral' },
		])
		expect(pickFacts(fields, null)).toEqual([])
		expect(pickFacts(undefined, { priority: 'P1' })).toEqual([])
	})

	it('shows at most three rows', () => {
		const metadata = { priority: 'P1', Role: 'CTO', Source: 'Referral', Company: 'Norlix' }
		expect(pickFacts(fields, metadata).map((f) => f.label)).toEqual(['Priority', 'Role', 'Source'])
	})

	it('reads numbers, booleans and lists as one line of text', () => {
		const metadata = { priority: 2, Role: false, Source: ['a', ' b ', ''], Company: 'two\nlines' }
		expect(pickFacts(fields, metadata)).toEqual([
			{ label: 'Priority', value: '2' },
			{ label: 'Role', value: 'false' },
			{ label: 'Source', value: 'a, b' },
		])
		expect(pickFacts([{ name: 'Company' }], metadata)).toEqual([
			{ label: 'Company', value: 'two lines' },
		])
	})

	it('writes field names and enum values as plain words', () => {
		const defs = [
			{ name: 'moves_the_bar', type: 'text' },
			{ name: 'advisor_conversation', type: 'enum' },
			{ name: 'stage', type: 'enum' },
		]
		const metadata = {
			moves_the_bar: 'yes_for_sure',
			advisor_conversation: 'not_started',
			stage: 'in-review',
		}
		expect(pickFacts(defs, metadata)).toEqual([
			{ label: 'Moves the bar', value: 'yes_for_sure' },
			{ label: 'Advisor conversation', value: 'Not started' },
			{ label: 'Stage', value: 'In review' },
		])
	})

	it('leaves out link fields, by name or by a web address', () => {
		const defs = [
			{ name: 'pr_url', type: 'text' },
			{ name: 'branch', type: 'text' },
			{ name: 'Docs link', type: 'text' },
			{ name: 'reference', type: 'text' },
			{ name: 'Role', type: 'text' },
		]
		const metadata = {
			pr_url: 'https://github.com/x/y/pull/1',
			branch: 'feat/task-1',
			'Docs link': 'https://example.com',
			reference: 'https://example.com/spec',
			Role: 'CTO',
		}
		expect(pickFacts(defs, metadata)).toEqual([{ label: 'Role', value: 'CTO' }])
	})
})

describe('unavailableCopy', () => {
	it('words the deleted card and chip', () => {
		expect(unavailableCopy('bet')).toEqual({
			card: 'This bet was deleted',
			chip: 'Deleted bet',
		})
	})
})

describe('unavailableCopy for a chat', () => {
	it('reads Chat not available on the card and the chip, never deleted', () => {
		expect(unavailableCopy('chat')).toEqual({
			card: 'Chat not available',
			chip: 'Chat not available',
		})
	})
})

describe('peopleLine', () => {
	it('lists up to three names', () => {
		expect(peopleLine(['Ada'])).toBe('Ada')
		expect(peopleLine(['Ada', 'Forge', 'Lin'])).toBe('Ada, Forge, Lin')
	})

	it('counts the rest after three names', () => {
		expect(peopleLine(['Ada', 'Forge', 'Lin', 'Max', 'Sol'])).toBe('Ada, Forge, Lin +2')
	})

	it('is null when nobody is in the chat', () => {
		expect(peopleLine([])).toBeNull()
	})
})

describe('chatSummary', () => {
	it('leads the last message with its author', () => {
		expect(chatSummary('Forge', 'Shipped the **fix**')).toBe('Forge: Shipped the fix')
	})

	it('shows the words alone when the author is not known', () => {
		expect(chatSummary(null, 'Shipped')).toBe('Shipped')
	})

	it('is null for a chat with no message, even with an author', () => {
		expect(chatSummary('Forge', '')).toBeNull()
		expect(chatSummary('Forge', null)).toBeNull()
		expect(chatSummary('Forge', undefined)).toBeNull()
	})
})
