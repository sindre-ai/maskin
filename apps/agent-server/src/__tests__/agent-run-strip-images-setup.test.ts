import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const script = readFileSync(
	new URL('../../../../docker/agent-base/agent-run.sh', import.meta.url),
	'utf8',
)
const fn = script.match(/^setup_strip_images_proxy\(\) \{\n[\s\S]*?^\}$/m)?.[0] ?? ''

// agent-run.sh runs under `set -eo pipefail`, so a setup function that returns
// non-zero kills the whole session before the agent starts.
function runUnderSetE(env: Record<string, string>) {
	return spawnSync(
		'bash',
		['-c', `set -eo pipefail\n${fn}\nsetup_strip_images_proxy\necho survived`],
		{ env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
	)
}

describe('agent-run.sh setup_strip_images_proxy', () => {
	it('is found in the script', () => {
		expect(fn).toContain('setup_strip_images_proxy()')
	})

	it('does not abort the script when MASKIN_STRIP_IMAGES is unset', () => {
		const res = runUnderSetE({})
		expect(res.stdout).toContain('survived')
		expect(res.status).toBe(0)
	})

	it('does not abort the script when ANTHROPIC_BASE_URL is empty', () => {
		const res = runUnderSetE({ MASKIN_STRIP_IMAGES: '1', ANTHROPIC_BASE_URL: '' })
		expect(res.stdout).toContain('survived')
		expect(res.status).toBe(0)
	})
})
