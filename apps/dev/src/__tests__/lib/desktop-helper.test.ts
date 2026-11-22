import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	CHROMIUM_FLAGS_LINE,
	buildRefreshHelperCommands,
	helperSha256,
} from '../../lib/desktop-helper'
import { DESKTOP_HELPER_SOURCE } from '../../lib/desktop-helper-source'
import { parseKeyValueLines } from '../../lib/desktop-settings'

// The commands run on the computer under sh and python3. Run them here for real against a
// throwaway folder (no sudo, no restart), so "writes only when different" and "a bad copy is
// refused" are checked on the actual script.
let dir: string
const targets = () => ({
	helperPath: join(dir, 'desktopd.py'),
	flagsPath: join(dir, 'desktop-flags'),
	stagingPath: join(dir, 'staging.b64'),
	sudo: false,
	restart: false,
	debugPort: 1, // nothing listens here
})
const run = (commands: string[]) => {
	let out = ''
	for (const command of commands) {
		out = execFileSync('sh', ['-c', command], { encoding: 'utf8' })
	}
	return parseKeyValueLines(out)
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'desktop-helper-'))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('desktop helper source', () => {
	// docker/desktop/desktopd.py is what new computers get; the server sends the same file to old ones.
	it('is the same file the image carries', () => {
		const onDisk = readFileSync(
			new URL('../../../../../docker/desktop/desktopd.py', import.meta.url),
			'utf8',
		)
		expect(DESKTOP_HELPER_SOURCE, 'run: node apps/dev/scripts/sync-desktop-helper.mjs').toBe(onDisk)
	})

	it('knows the action an old computer lacks', () => {
		expect(DESKTOP_HELPER_SOURCE).toContain('type_secret')
	})
})

describe('buildRefreshHelperCommands', () => {
	it('keeps every command under the 10,000 character exec limit, with room to grow', () => {
		for (const command of buildRefreshHelperCommands()) {
			expect(command.length).toBeLessThan(9_000)
		}
	})

	it('installs the helper on an old computer and says so', () => {
		writeFileSync(targets().helperPath, 'old helper without type_secret\n')

		const out = run(buildRefreshHelperCommands(targets()))

		expect(out).toMatchObject({ helper_changed: '1', helper_restarting: '0', debug_port_open: '0' })
		expect(readFileSync(targets().helperPath, 'utf8')).toBe(DESKTOP_HELPER_SOURCE)
	})

	it('changes nothing on a second run', () => {
		run(buildRefreshHelperCommands(targets()))
		const first = readFileSync(targets().helperPath)

		const out = run(buildRefreshHelperCommands(targets()))

		expect(out).toMatchObject({ helper_changed: '0', flags_changed: '0' })
		expect(readFileSync(targets().helperPath).equals(first)).toBe(true)
	})

	it('adds the browser debugging port to the flags file only when it is missing', () => {
		writeFileSync(targets().flagsPath, 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --disable-gpu"\n')

		expect(run(buildRefreshHelperCommands(targets()))).toMatchObject({ flags_changed: '1' })
		expect(readFileSync(targets().flagsPath, 'utf8')).toBe(`${CHROMIUM_FLAGS_LINE}\n`)
		expect(run(buildRefreshHelperCommands(targets()))).toMatchObject({ flags_changed: '0' })
	})

	it('refuses a copy that does not match its hash and installs nothing', () => {
		const commands = buildRefreshHelperCommands(targets())
		// Corrupt the last piece of the payload on its way to the computer.
		const piece = commands.length - 2
		commands[piece] = commands[piece]?.replace(/'([^']*)'/, (_m, b64: string) => {
			return `'${b64.slice(0, -8)}AAAAAAAA'`
		}) as string

		expect(() => run(commands)).toThrow()
		expect(() => readFileSync(targets().helperPath)).toThrow()
	})

	it('hashes the source it sends', () => {
		expect(helperSha256('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})
})
