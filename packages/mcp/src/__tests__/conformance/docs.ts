// Renders docs/reference/mcp-conformance.md from the matrix rows plus the
// hand-written sections in docs-content.ts. Pure function: no I/O.

import {
	CHANGELOG,
	FLAG,
	HOW_TO_RUN,
	INTRO,
	MODES,
	PAGE_FRONTMATTER,
	TIMELINE,
} from './docs-content'
import { ROWS } from './rows'
import { type ClientStyle, type Row, STYLE_LABELS } from './types'

const SHORT: Record<ClientStyle, string> = {
	'raw-legacy': 'raw legacy',
	'sdk-legacy': 'SDK legacy',
	'sdk-auto': 'SDK auto',
	'sdk-modern': 'SDK modern',
	'raw-modern': 'raw modern',
}

function needsOf(row: Row): string {
	const needs: string[] = []
	if (row.flag === 'off') needs.push('flag off')
	if (row.needs?.includes('cache-hints')) needs.push('cache hints')
	if (row.needsResponseCap) needs.push('lowered response cap')
	if (!row.flag && row.styles.some((s) => s === 'raw-modern' || s === 'sdk-modern')) {
		needs.push('modern leg (flag on)')
	}
	return needs.length ? needs.join(', ') : '-'
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function renderConformanceDocs(today: string): string {
	const out: string[] = []
	out.push('---')
	out.push(`title: ${PAGE_FRONTMATTER.title}`)
	out.push(`slug: ${PAGE_FRONTMATTER.slug}`)
	out.push(`description: ${PAGE_FRONTMATTER.description}`)
	out.push(`last_updated: ${today}`)
	out.push('---')
	out.push('')
	out.push(`# ${PAGE_FRONTMATTER.title}`)
	out.push('')
	out.push(
		'> Generated from `packages/mcp/src/__tests__/conformance/` by `pnpm --filter @maskin/mcp conformance:docs`. Do not edit by hand: change a row in `rows.ts` or the prose in `docs-content.ts`, then regenerate.',
	)
	out.push('')
	out.push(INTRO)
	out.push('')
	out.push(`## ${MODES.heading}`)
	out.push('')
	out.push(MODES.intro)
	out.push('')
	out.push('| Mode | What the client does | Result against this server |')
	out.push('| --- | --- | --- |')
	for (const m of MODES.rows) out.push(`| ${m.mode} | ${cell(m.how)} | ${cell(m.result)} |`)
	out.push('')
	out.push(FLAG)
	out.push('')
	out.push(`## ${TIMELINE.heading}`)
	out.push('')
	out.push(TIMELINE.intro)
	out.push('')
	out.push('| When | What |')
	out.push('| --- | --- |')
	for (const t of TIMELINE.rows) out.push(`| ${t.when} | ${cell(t.what)} |`)
	out.push('')
	out.push(`## ${CHANGELOG.heading}`)
	out.push('')
	for (const entry of CHANGELOG.entries) {
		out.push(`### ${entry.title}`)
		out.push('')
		for (const b of entry.bullets) out.push(`- ${b}`)
		out.push('')
	}
	out.push('## Client styles in the matrix')
	out.push('')
	out.push('| Style | What it is |')
	out.push('| --- | --- |')
	for (const [style, label] of Object.entries(STYLE_LABELS)) {
		out.push(`| ${SHORT[style as ClientStyle]} | ${label} |`)
	}
	out.push('')
	out.push('## The conformance matrix')
	out.push('')
	out.push(
		`${ROWS.length} rows. Each row is one behaviour of \`/mcp\`, run against every client style listed for it.`,
	)
	out.push('')
	const areas = [...new Set(ROWS.map((r) => r.area))]
	for (const area of areas) {
		out.push(`### ${area}`)
		out.push('')
		out.push('| Row | What a pass guarantees | Client styles | Needs |')
		out.push('| --- | --- | --- | --- |')
		for (const row of ROWS.filter((r) => r.area === area)) {
			out.push(
				`| \`${row.id}\`: ${cell(row.title)} | ${cell(row.proves)} | ${row.styles
					.map((s) => SHORT[s])
					.join(', ')} | ${needsOf(row)} |`,
			)
		}
		out.push('')
	}
	out.push(HOW_TO_RUN)
	out.push('')
	return out.join('\n')
}
