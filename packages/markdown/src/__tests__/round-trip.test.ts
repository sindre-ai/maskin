import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeMarkdown } from '../serialize'

const roundTripDir = join(__dirname, '..', '__fixtures__', 'round-trip')
const canonicalizeDir = join(__dirname, '..', '__fixtures__', 'canonicalize')

const roundTripFixtures = readdirSync(roundTripDir)
	.filter((name) => name.endsWith('.md') && name !== 'README.md')
	.sort()

const canonicalizeFixtures = readdirSync(canonicalizeDir)
	.filter((name) => name.endsWith('.input.md'))
	.map((name) => name.replace('.input.md', ''))
	.sort()

// This is the core CI gate for the tiptap-editor bet: every Markdown fixture
// under `__fixtures__/round-trip/` must survive `serialize(parse(source))`
// byte-exact. Divergence means the serializer normalised an untouched block,
// which breaks the agent-diff workflow the bet is built on.
describe('GFM round-trip corpus', () => {
	it('covers at least 10 canonical fixtures', () => {
		expect(roundTripFixtures.length).toBeGreaterThanOrEqual(10)
	})

	for (const fixture of roundTripFixtures) {
		it(`round-trips ${fixture} byte-exact`, () => {
			const source = readFileSync(join(roundTripDir, fixture), 'utf8')
			const output = serializeMarkdown(source)
			expect(output).toBe(source)
		})
	}
})

// A regression-detection test: parse a fixture, mutate the source with a
// change the serializer will normalise away (trailing whitespace on every
// line), and assert the pipeline flags the divergence. If this test ever
// passes silently, the round-trip check has become vacuous — any real
// regression would slip through.
describe('mutation detection', () => {
	it('flags trailing whitespace injected into a canonical fixture', () => {
		const source = readFileSync(join(roundTripDir, '03-list-tight.md'), 'utf8')
		const mutated = source
			.split('\n')
			.map((line) => (line.length > 0 ? `${line}   ` : line))
			.join('\n')
		const output = serializeMarkdown(mutated)
		expect(output).not.toBe(mutated)
	})

	it('flags an ATX heading downgraded to setext form', () => {
		const source = '# Real heading\n\nParagraph.\n'
		const mutated = 'Real heading\n============\n\nParagraph.\n'
		const output = serializeMarkdown(mutated)
		expect(output).not.toBe(mutated)
	})
})

// Canonicalisation fixtures test the non-canonical shapes named in the task
// DoD — indented code, setext headings, two-space hard breaks. These do NOT
// round-trip byte-exact: the write pipeline normalises them to canonical
// form on the first pass. Coverage here is (a) the first pass produces the
// expected canonical output, and (b) the second pass is stable (idempotent).
describe('canonicalisation (non-canonical shapes normalise deterministically)', () => {
	for (const name of canonicalizeFixtures) {
		it(`normalises ${name} to canonical form and is idempotent`, () => {
			const input = readFileSync(join(canonicalizeDir, `${name}.input.md`), 'utf8')
			const expected = readFileSync(join(canonicalizeDir, `${name}.expected.md`), 'utf8')
			const firstPass = serializeMarkdown(input)
			expect(firstPass).toBe(expected)
			const secondPass = serializeMarkdown(firstPass)
			expect(secondPass).toBe(firstPass)
		})
	}
})
