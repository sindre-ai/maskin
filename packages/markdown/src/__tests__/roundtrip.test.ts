// Load-bearing de-risk for the `tiptap-markdown` bet.
//
// Every fixture in `./fixtures/*.md` is a verbatim copy-paste from a live
// object in the Maskin workspace (bet body, task body, knowledge body, or
// comment) — see `fixtures/manifest.ts` for the provenance table. The
// contract each fixture asserts is *idempotence after one full round-trip*:
//
//   serialize(parse(serialize(parse(md)))) === serialize(parse(md))
//
// The first `serialize(parse(md))` is allowed to normalize the input (setext
// → ATX headings, autolinks wrapped in `<>`, etc.). The second must match the
// first byte-for-byte. Drift on the second pass means `tiptap-markdown` is
// throwing information away — an agent-generated blob would silently lose
// content on save if this suite passed and reality regressed.
//
// The bet's load-bearing sizing assumption (tech spec §13) is that
// `tiptap-markdown` handles ≥95% of agent-generated blobs losslessly. This
// suite is the truth test — if it reports >5% loss across a real-content
// sample, the driver STOPS and escalates to Planner.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertIdempotent, roundTrip } from '../roundtrip'
import { FIXTURES } from './fixtures/manifest'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixture(file: string): string {
	return readFileSync(join(FIXTURES_DIR, file), 'utf8')
}

describe('tiptap-markdown round-trip — real agent-generated fixtures', () => {
	// AC: ≥20 real blobs. This is a hard floor — dropping below invalidates
	// the "sample big enough to trust the ≥95% fidelity claim" argument.
	it('has at least 20 fixtures registered', () => {
		expect(FIXTURES.length).toBeGreaterThanOrEqual(20)
	})

	it('every fixture has provenance pointing at a Maskin object', () => {
		for (const fixture of FIXTURES) {
			expect(fixture.sourceUrl, `fixture ${fixture.file} missing source url`).toMatch(
				/^https:\/\/maskin\.io\/[a-f0-9-]{36}\/(objects|files)\/[a-f0-9-]{36}$/,
			)
		}
	})

	it('every registered fixture file is readable', () => {
		for (const fixture of FIXTURES) {
			const body = loadFixture(fixture.file)
			expect(body.length, `fixture ${fixture.file} is empty`).toBeGreaterThan(0)
		}
	})

	// Per-fixture idempotence — the AC contract, one assertion per blob so a
	// failure names the drifting fixture rather than collapsing 20+ into one
	// red bar.
	describe.each(FIXTURES)('$label', (fixture) => {
		it(`round-trips idempotently (${fixture.file})`, () => {
			const source = loadFixture(fixture.file)
			const result = assertIdempotent(source)
			if (!result.ok) {
				// Surface a compact diff so the failure is diagnosable without
				// re-running under a debugger. Fixture, first pass, second pass.
				throw new Error(
					`Round-trip drift on second pass — fixture ${fixture.file}.\nSource (${fixture.sourceUrl})\n--- first pass ---\n${result.first}\n--- second pass ---\n${result.second}\n--- end ---`,
				)
			}
			expect(result.ok).toBe(true)
		})
	})

	// Guard against a silent-empty regression — an editor bug that returns
	// `''` for every input would satisfy `first === second` trivially. Assert
	// the normalized output has real content on the largest fixture (the
	// September 2026 knowledge doc), which is impossible to compress to empty.
	it('roundtrip is not degenerate — big fixtures still produce content', () => {
		const knowledge = loadFixture('07-knowledge-september-2026.md')
		const normalized = roundTrip(knowledge)
		expect(normalized.length).toBeGreaterThan(500)
		expect(normalized).toContain('September 2026')
	})
})

// The AC calls out the ```chart fenced block specifically — a Maskin custom
// where the reader's `code` override renders a recharts visual, but the
// editor and CI round-trip must preserve the fence + body verbatim. Fixture
// 14 carries a real agent-emitted chart; assert its body survives the
// normalized round-trip so a serializer regression that strips fence
// languages doesn't get past this suite.
describe('```chart fenced block preservation', () => {
	it('round-trips the chart fence + JSON body verbatim', () => {
		const source = loadFixture('14-insight-doctrine-cluster-with-chart.md')
		const normalized = roundTrip(source)
		expect(normalized).toContain('```chart')
		expect(normalized).toContain('"type":"bar"')
		expect(normalized).toContain('"caption":"Doctrine cluster — fully shipped 2026-08-23"')
	})
})
