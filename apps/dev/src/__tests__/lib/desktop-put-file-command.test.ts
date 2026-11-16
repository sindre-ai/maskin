import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	FETCH_FREE_HEADROOM_BYTES,
	NO_ROOM_EXIT_CODE,
	buildPutFileCommand,
	formatBytes,
} from '../../lib/desktop-put-file-command'

// These run the real script with `sh`, the shell the computer uses, against a temp home.
// Only `df` and `wget` are stand-ins: df reports a disk of DISK_BYTES minus what is in
// Downloads (so removing a file really frees room), wget copies a local file.
const DISK_BYTES = 3 * 1024 ** 3
const HOUR = 3600

let home: string
let bin: string
let source: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'put-file-home-'))
	bin = join(home, '.bin')
	mkdirSync(bin)
	source = join(home, 'incoming.bin')
	writeFileSync(source, 'x')
	// Fake sizes: a file's "size" for df is its byte length times SCALE, so a few bytes stand in for GB.
	writeFileSync(
		join(bin, 'df'),
		`#!/bin/sh
used=0
for f in "$HOME"/Downloads/* "$HOME"/Downloads/.[!.]*; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  used=$((used + $(stat -c %s "$f") * ${1024 ** 3}))
done
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "fake 1 1 $(((${DISK_BYTES} - used) / 1024)) 5% /"
`,
	)
	writeFileSync(
		join(bin, 'wget'),
		`#!/bin/sh
echo called >> "$HOME"/wget-calls
while [ $# -gt 0 ]; do [ "$1" = -O ] && out=$2; shift; done
cp "${source}" "$out"
`,
	)
	chmodSync(join(bin, 'df'), 0o755)
	chmodSync(join(bin, 'wget'), 0o755)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

const downloads = () => join(home, 'Downloads')

/** A file with `gb` fake gigabytes (one byte per fake GB), recorded `ageSeconds` ago. */
function placeFetched(name: string, gb: number, ageSeconds: number, record = true) {
	mkdirSync(downloads(), { recursive: true })
	const path = join(downloads(), name)
	writeFileSync(path, 'x'.repeat(gb))
	if (record) {
		const at = Math.floor(Date.now() / 1000) - ageSeconds
		writeFileSync(join(home, '.maskin-fetched'), `${at} ${path}\n`, { flag: 'a' })
	}
	return path
}

function run(sizeBytes: number) {
	const command = buildPutFileCommand({
		folder: '~/Downloads',
		fileName: 'video.mp4',
		url: 'https://storage.example/key?sig=1',
		sizeBytes,
	})
	return spawnSync('sh', ['-c', command], {
		env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
		encoding: 'utf8',
	})
}

describe('buildPutFileCommand', () => {
	it('downloads the file, records it, and prints path, hash, size and free space', () => {
		const res = run(1024)

		expect(res.status).toBe(0)
		const [path, sha, size, free] = res.stdout.trim().split('\n')
		expect(path).toBe(join(downloads(), 'video.mp4'))
		expect(sha).toMatch(/^[0-9a-f]{64}$/)
		expect(size).toBe(String(statSync(source).size))
		// The new file is one byte, which the fake df counts as 1 GB.
		expect(Number(free)).toBe(DISK_BYTES - statSync(source).size * 1024 ** 3)
		expect(readFileSync(join(home, '.maskin-fetched'), 'utf8')).toMatch(
			new RegExp(`^\\d+ ${path}\\n$`),
		)
	})

	it('removes recorded files older than 24 hours and leaves everything else', () => {
		const old = placeFetched('old.mp4', 0, 25 * HOUR)
		const day = placeFetched('recent.mp4', 0, 2 * HOUR)
		const unrecorded = placeFetched('made-by-agent.mp4', 0, 99 * HOUR, false)

		const res = run(1024)

		expect(res.status).toBe(0)
		expect(existsSync(old)).toBe(false)
		expect(existsSync(day)).toBe(true)
		expect(existsSync(unrecorded)).toBe(true)
		const record = readFileSync(join(home, '.maskin-fetched'), 'utf8')
		expect(record).not.toContain('old.mp4')
		expect(record).toContain('recent.mp4')
		expect(record).not.toContain('made-by-agent.mp4')
	})

	it('makes room from recorded files older than an hour, oldest first, and stops when there is room', () => {
		// Incoming file: 1 GB (fake). Needs 1 GB + 1 GB headroom = 2 GB free of 3 GB.
		// Disk holds 2 GB (old) + the recorded files below, so it is short.
		const oldest = placeFetched('oldest.mp4', 1, 5 * HOUR)
		const older = placeFetched('older.mp4', 1, 3 * HOUR)
		const young = placeFetched('young.mp4', 1, HOUR / 2)
		const unrecorded = placeFetched('mine.mp4', 0, 9 * HOUR, false)

		// 3 recorded fake GB used: 0 free. Removing the oldest frees 1 GB, which is still short
		// of 2 GB, so the second oldest goes too; then there is room and the young one stays.
		const res = run(1024 ** 3)

		expect(res.status).toBe(0)
		expect(existsSync(oldest)).toBe(false)
		expect(existsSync(older)).toBe(false)
		expect(existsSync(young)).toBe(true)
		expect(existsSync(unrecorded)).toBe(true)
	})

	it('refuses, naming the free space, when only young files fill the disk, and downloads nothing', () => {
		const young = placeFetched('young.mp4', 3, HOUR / 2)

		const res = run(1024 ** 3)

		expect(res.status).toBe(NO_ROOM_EXIT_CODE)
		expect(res.stdout.trim()).toBe('NOROOM 0')
		expect(existsSync(young)).toBe(true)
		expect(existsSync(join(home, 'wget-calls'))).toBe(false)
		expect(existsSync(join(downloads(), 'video.mp4'))).toBe(false)
	})

	it('does not follow a symlink that replaced a recorded file', () => {
		mkdirSync(downloads(), { recursive: true })
		const target = join(home, 'precious.txt')
		writeFileSync(target, 'keep me')
		const link = join(downloads(), 'link.mp4')
		symlinkSync(target, link)
		const at = Math.floor(Date.now() / 1000) - 30 * HOUR
		writeFileSync(join(home, '.maskin-fetched'), `${at} ${link}\n`)

		expect(run(1024).status).toBe(0)

		expect(existsSync(target)).toBe(true)
	})

	it('drops a record line for a file that is already gone, and a damaged line', () => {
		writeFileSync(
			join(home, '.maskin-fetched'),
			`${Math.floor(Date.now() / 1000)} ${join(downloads(), 'gone.mp4')}\nnot-a-time /x\n`,
		)

		expect(run(1024).status).toBe(0)

		const record = readFileSync(join(home, '.maskin-fetched'), 'utf8')
		expect(record).not.toContain('gone.mp4')
		expect(record).not.toContain('not-a-time')
	})

	it('keeps a fetched copy fresh when the same file is fetched again', () => {
		placeFetched('video.mp4', 1, 2 * HOUR)

		const res = run(1024)

		expect(res.status).toBe(0)
		const lines = readFileSync(join(home, '.maskin-fetched'), 'utf8').trim().split('\n')
		expect(lines).toHaveLength(1)
		expect(Number(lines[0]?.split(' ')[0])).toBeGreaterThan(Date.now() / 1000 - 60)
	})
})

describe('formatBytes', () => {
	it('uses GB, MB and KB', () => {
		expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
		expect(formatBytes(340 * 1024 ** 2)).toBe('340 MB')
		expect(formatBytes(2048)).toBe('2 KB')
		expect(FETCH_FREE_HEADROOM_BYTES).toBe(1024 ** 3)
	})
})
