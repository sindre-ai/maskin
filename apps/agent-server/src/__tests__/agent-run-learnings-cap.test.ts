import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = readFileSync(
	new URL('../../../../docker/agent-base/agent-run.sh', import.meta.url),
	'utf8',
)
const fn = script.match(/^build_context\(\) \{\n[\s\S]*?^\}$/m)?.[0] ?? ''
const cap = script.match(/^LEARNINGS_MAX_BYTES=(\d+)$/m)?.[1] ?? ''

let dir: string

// Runs build_context against a scratch directory instead of /agent.
function run(learnings: string | null) {
	mkdirSync(join(dir, 'memory'), { recursive: true })
	mkdirSync(join(dir, 'workspace'), { recursive: true })
	if (learnings !== null) writeFileSync(join(dir, 'memory/consolidated-learnings.md'), learnings)
	const body = fn.replaceAll('/agent/', `${dir}/`)
	const res = spawnSync(
		'bash',
		['-c', `set -eo pipefail\nLEARNINGS_MAX_BYTES=${cap}\n${body}\nbuild_context`],
		{
			env: { PATH: process.env.PATH ?? '', SYSTEM_PROMPT: 'persona', ACTION_PROMPT: '' },
			encoding: 'utf8',
		},
	)
	const context = readFileSync(join(dir, 'workspace/CLAUDE.md'), 'utf8')
	const sizeLine = res.stdout.match(/\[system\] start prompt size: (.*)/)?.[1] ?? ''
	return { res, context, sizeLine }
}

const entries = (n: number) =>
	`# Learnings\n\n${Array.from({ length: n }, (_, i) => `## Entry ${i + 1}\n${`text ${i + 1}\n`.repeat(20)}\n`).join('')}`

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'agent-run-learnings-'))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('agent-run.sh build_context learnings cap', () => {
	it('is found in the script with the 20 KB cap', () => {
		expect(fn).toContain('build_context()')
		expect(cap).toBe('20480')
	})

	it('pastes a file under the cap whole and says it was not capped', () => {
		const text = entries(5)
		const { res, context, sizeLine } = run(text)
		expect(res.status).toBe(0)
		expect(context).toContain(text)
		expect(sizeLine).toContain(`learnings_bytes=${Buffer.byteLength(text)}`)
		expect(sizeLine).toContain('learnings_capped=false')
	})

	it('cuts a long file to at most 20 KB, on a heading, keeping the newest entries', () => {
		const text = entries(200)
		const { res, context, sizeLine } = run(text)
		expect(res.status).toBe(0)
		const pasted = Number(sizeLine.match(/learnings_bytes=(\d+)/)?.[1])
		expect(pasted).toBeGreaterThan(0)
		expect(pasted).toBeLessThanOrEqual(20480)
		expect(sizeLine).toContain('learnings_capped=true')
		// newest kept, oldest dropped, and the kept part starts on a heading
		expect(context).toContain('text 200')
		expect(context).not.toContain('## Entry 1\n')
		const kept =
			context.split('Read the full file at')[1]?.split('\n\n').slice(1).join('\n\n') ?? ''
		expect(kept.startsWith('## Entry ')).toBe(true)
		// one line says a longer file exists and where
		expect(context).toContain('Older learnings are left out here')
		expect(context).toContain(`${dir}/memory/consolidated-learnings.md`)
	})

	it('reports zero bytes and not capped when there is no memory file', () => {
		const { res, sizeLine } = run(null)
		expect(res.status).toBe(0)
		expect(sizeLine).toContain('learnings_bytes=0')
		expect(sizeLine).toContain('learnings_capped=false')
	})
})
