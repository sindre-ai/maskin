import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	CHOOSER_KEYS,
	CHOOSER_SECTION,
	DESKTOP_SETTINGS_VERSION,
	SETTINGS_FILES,
	buildApplySettingsCommand,
	buildReadSettingsCommand,
	parseKeyValueLines,
} from '../../lib/desktop-settings'

// The commands run on the computer under sh and python3. Run them here for real against a
// throwaway home folder, so "only the listed keys change" and "twice changes nothing" are
// checked on the actual script, not on its text.
let home: string

const run = (command: string) =>
	parseKeyValueLines(
		execFileSync('sh', ['-c', command], { env: { ...process.env, HOME: home }, encoding: 'utf8' }),
	)
const path = (rel: string) => join(home, rel)
const writeUnderHome = (rel: string, text: string) => {
	mkdirSync(dirname(path(rel)), { recursive: true })
	writeFileSync(path(rel), text)
}
const keyfile = () => readFileSync(path(SETTINGS_FILES.keyfile), 'utf8')

const PLANK = "[net/launchpad/plank/docks/dock1]\ntheme='Maskin'\nicon-size=56\n"
const WANTED =
	'[org/gtk/settings/file-chooser]\nwindow-position=(400, 20)\nwindow-size=(800, 480)\n'

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'desktop-settings-'))
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

describe('buildApplySettingsCommand', () => {
	it('fixes a chooser that GTK resized and leaves every other setting alone', () => {
		writeUnderHome(
			SETTINGS_FILES.keyfile,
			`${PLANK}\n[org/gtk/settings/file-chooser]\nwindow-position=(0, 0)\nwindow-size=(1124, 822)\nsort-column='name'\n\n[other/section]\nkeep=me\n`,
		)

		const out = run(buildApplySettingsCommand())

		expect(out).toMatchObject({ keyfile_changed: '1', settings_version: '1' })
		expect(keyfile()).toBe(
			`${PLANK}\n[org/gtk/settings/file-chooser]\nwindow-position=(400, 20)\nwindow-size=(800, 480)\nsort-column='name'\n\n[other/section]\nkeep=me\n`,
		)
	})

	it('writes the section when the file has none, and the file when there is none', () => {
		writeUnderHome(SETTINGS_FILES.keyfile, PLANK)
		run(buildApplySettingsCommand())
		expect(keyfile()).toBe(`${PLANK}\n${WANTED}`)

		rmSync(path(SETTINGS_FILES.keyfile))
		run(buildApplySettingsCommand())
		expect(keyfile()).toBe(WANTED)
	})

	it('changes nothing the second time', () => {
		writeUnderHome(SETTINGS_FILES.keyfile, PLANK)
		const first = run(buildApplySettingsCommand())
		const after = keyfile()

		const second = run(buildApplySettingsCommand())

		expect(first).toMatchObject({ keyfile_changed: '1', marker_changed: '1' })
		expect(second).toMatchObject({ keyfile_changed: '0', marker_changed: '0' })
		expect(keyfile()).toBe(after)
	})

	it('records the version it wrote, and touches no other file under the home folder', () => {
		writeUnderHome(SETTINGS_FILES.keyfile, PLANK)
		writeUnderHome('.config/chromium/Default/Cookies', 'a saved login')
		writeUnderHome('.config/chromium/Default/Preferences', '{"zoom":1}')

		run(buildApplySettingsCommand())

		expect(readFileSync(path(SETTINGS_FILES.marker), 'utf8')).toBe(`${DESKTOP_SETTINGS_VERSION}\n`)
		expect(readFileSync(path('.config/chromium/Default/Cookies'), 'utf8')).toBe('a saved login')
		expect(readFileSync(path('.config/chromium/Default/Preferences'), 'utf8')).toBe('{"zoom":1}')
	})

	it('builds one command from constants, with no caller input in it', () => {
		const command = buildApplySettingsCommand()
		expect(command).toContain(CHOOSER_SECTION)
		for (const [key, value] of CHOOSER_KEYS) expect(command).toContain(`["${key}","${value}"]`)
		expect(buildApplySettingsCommand()).toBe(command)
	})
})

describe('buildReadSettingsCommand', () => {
	it('reads the version, chooser and disk, and writes nothing', () => {
		writeUnderHome(SETTINGS_FILES.keyfile, `${PLANK}\n${WANTED}`)
		writeUnderHome(SETTINGS_FILES.marker, '1\n')

		const out = run(buildReadSettingsCommand())

		expect(out).toMatchObject({
			settings_version: '1',
			chooser_size: '(800, 480)',
			chooser_position: '(400, 20)',
		})
		expect(Number(out.disk_total_mb)).toBeGreaterThan(0)
		expect(Number(out.disk_free_mb)).toBeGreaterThanOrEqual(0)
		expect(keyfile()).toBe(`${PLANK}\n${WANTED}`)
	})

	it('answers empty values for a computer that never had the settings applied', () => {
		const out = run(buildReadSettingsCommand())

		expect(out.settings_version).toBe('')
		expect(out.chooser_size).toBe('')
	})
})

describe('parseKeyValueLines', () => {
	it('keeps everything after the first =, and skips lines with none', () => {
		expect(parseKeyValueLines('a=1\nnoise\nb=x=y\n=bad\n')).toEqual({ a: '1', b: 'x=y' })
	})
})
