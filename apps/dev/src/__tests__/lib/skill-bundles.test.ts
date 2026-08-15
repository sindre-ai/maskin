import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import {
	SKILL_BUNDLE_MAX_ENTRIES,
	SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES,
	extractSkillBundle,
} from '../../lib/skill-bundles'

function makeZip(entries: Record<string, string | Buffer>): Buffer {
	const zip = new AdmZip()
	for (const [path, content] of Object.entries(entries)) {
		zip.addFile(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'))
	}
	return zip.toBuffer()
}

const SKILL_MD = '---\nname: docx\ndescription: Anthropic docx skill\n---\n\nDoc generator.'

describe('extractSkillBundle', () => {
	it('accepts a flat bundle with SKILL.md at the root', () => {
		const buf = makeZip({
			'SKILL.md': SKILL_MD,
			'reference/style.md': 'Reference content',
		})
		const result = extractSkillBundle(buf)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.bundle.entries).toHaveLength(2)
		expect(result.bundle.skillMd.content).toBe(SKILL_MD)
		// Anthropic-shaped reference file made it through unchanged.
		const reference = result.bundle.entries.find((e) => e.path === 'reference/style.md')
		expect(reference?.data.toString('utf-8')).toBe('Reference content')
	})

	it('strips a single wrapping directory', () => {
		const buf = makeZip({
			'docx/SKILL.md': SKILL_MD,
			'docx/reference/style.md': 'Style guide',
			'docx/scripts/run.py': 'print("hi")',
		})
		const result = extractSkillBundle(buf)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const paths = result.bundle.entries.map((e) => e.path).sort()
		expect(paths).toEqual(['SKILL.md', 'reference/style.md', 'scripts/run.py'])
	})

	it('rejects a bundle with no SKILL.md', () => {
		const buf = makeZip({ 'README.md': 'just a readme' })
		const result = extractSkillBundle(buf)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.kind).toBe('no_skill_md')
	})

	it('rejects path-traversal entries', () => {
		// adm-zip's addFile() sanitises traversal sequences on the way in, so we
		// build the entry directly to simulate a hand-crafted malicious zip that
		// could otherwise land outside the skill prefix on disk.
		const zip = new AdmZip()
		zip.addFile('SKILL.md', Buffer.from(SKILL_MD, 'utf-8'))
		const entry = zip.getEntry('SKILL.md')
		if (entry) {
			zip.addFile('placeholder.txt', Buffer.from('x', 'utf-8'))
			const evil = zip.getEntry('placeholder.txt')
			if (evil) evil.entryName = '../escape.txt'
		}
		const result = extractSkillBundle(zip.toBuffer())
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.kind).toBe('unsafe_path')
	})

	it('rejects oversize bundles', () => {
		// Single entry that exceeds the per-entry cap.
		const huge = Buffer.alloc(SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES + 1024, 'a')
		const buf = makeZip({ 'SKILL.md': SKILL_MD, 'huge.bin': huge })
		const result = extractSkillBundle(buf)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.kind).toBe('too_large')
	})

	it('rejects bundles exceeding the entry count cap', () => {
		const entries: Record<string, string> = { 'SKILL.md': SKILL_MD }
		for (let i = 0; i < SKILL_BUNDLE_MAX_ENTRIES + 5; i++) {
			entries[`reference/note-${i}.md`] = `note ${i}`
		}
		const buf = makeZip(entries)
		const result = extractSkillBundle(buf)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.kind).toBe('too_many_entries')
	})

	it('rejects non-zip input gracefully', () => {
		const result = extractSkillBundle(Buffer.from('not a zip at all'))
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.kind).toBe('zip_invalid')
	})
})
