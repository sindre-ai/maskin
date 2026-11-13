import { execFileSync, spawnSync } from 'node:child_process'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	EMPTY_EXIT_CODE,
	NOT_ALLOWED_EXIT_CODE,
	NOT_FOUND_EXIT_CODE,
	TOO_BIG_EXIT_CODE,
	buildSaveFileCommand,
	mimeTypeForFileName,
} from '../../lib/desktop-save-file-command'

const URL_WITH_SIGNATURE = "https://storage.example/bucket/key?X-Amz-Signature=a'b&x=1"

// Runs the generated script for real under sh, with HOME in a temp folder and a stand-in wget
// that copies the body file instead of calling the network (the sandbox has no wget).
describe('buildSaveFileCommand', () => {
	let root: string
	let home: string
	let sent: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'save-file-'))
		home = join(root, 'home')
		sent = join(root, 'sent.bin')
		mkdirSync(join(home, 'renders'), { recursive: true })
		mkdirSync(join(home, '.config', 'chromium'), { recursive: true })
		mkdirSync(join(root, 'bin'))
		writeFileSync(
			join(root, 'bin', 'wget'),
			`#!/bin/sh
for a in "$@"; do
  case $a in
    --body-file=*) cp "\${a#--body-file=}" "${sent}" ;;
    --method=PUT) put=1 ;;
  esac
done
[ "$put" = 1 ] || exit 9
printf '%s\\n' "$@" > "${root}/args.txt"
`,
		)
		chmodSync(join(root, 'bin', 'wget'), 0o755)
	})

	afterEach(() => rmSync(root, { recursive: true, force: true }))

	const run = (path: string, maxBytes = 1000) =>
		spawnSync('sh', ['-c', buildSaveFileCommand({ path, url: URL_WITH_SIGNATURE, maxBytes })], {
			cwd: root,
			env: { HOME: home, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
			encoding: 'utf8',
		})

	it('sends a file under home with PUT and reports path, size, sha256 and size after', () => {
		writeFileSync(join(home, 'renders', 'clip.mp4'), 'hello world')

		const res = run('~/renders/clip.mp4')

		expect(res.status).toBe(0)
		const [path, size, sha, after] = res.stdout.trim().split('\n')
		expect(path).toBe(join(home, 'renders', 'clip.mp4'))
		expect(size).toBe('11')
		expect(sha).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
		expect(after).toBe('11')
		expect(readFileSync(sent, 'utf8')).toBe('hello world')
		// The signed URL reaches wget as one untouched argument.
		expect(readFileSync(join(root, 'args.txt'), 'utf8')).toContain(URL_WITH_SIGNATURE)
	})

	it('takes an absolute path inside home and resolves ".." out of it', () => {
		writeFileSync(join(home, 'renders', 'clip.mp4'), 'x')

		const res = run(`${home}/renders/../renders/clip.mp4`)

		expect(res.status).toBe(0)
		expect(res.stdout.split('\n')[0]).toBe(join(home, 'renders', 'clip.mp4'))
	})

	it('refuses a path outside home and uploads nothing', () => {
		writeFileSync(join(root, 'outside.txt'), 'secret')

		const res = run(join(root, 'outside.txt'))

		expect(res.status).toBe(NOT_ALLOWED_EXIT_CODE)
		expect(() => readFileSync(sent)).toThrow()
	})

	it('refuses a link under home that points outside it', () => {
		writeFileSync(join(root, 'outside.txt'), 'secret')
		symlinkSync(join(root, 'outside.txt'), join(home, 'renders', 'link.txt'))

		expect(run('~/renders/link.txt').status).toBe(NOT_ALLOWED_EXIT_CODE)
	})

	it('refuses a file inside a hidden folder, where the browser keeps its logins', () => {
		writeFileSync(join(home, '.config', 'chromium', 'Cookies'), 'cookies')

		expect(run('~/.config/chromium/Cookies').status).toBe(NOT_ALLOWED_EXIT_CODE)
		expect(() => readFileSync(sent)).toThrow()
	})

	it('refuses a hidden file directly under home', () => {
		writeFileSync(join(home, '.netrc'), 'login')

		expect(run('~/.netrc').status).toBe(NOT_ALLOWED_EXIT_CODE)
	})

	it('reports a missing file and a folder as not found', () => {
		expect(run('~/renders/nope.mp4').status).toBe(NOT_FOUND_EXIT_CODE)
		expect(run('~/renders').status).toBe(NOT_FOUND_EXIT_CODE)
	})

	it('refuses an empty file', () => {
		writeFileSync(join(home, 'renders', 'empty.mp4'), '')

		expect(run('~/renders/empty.mp4').status).toBe(EMPTY_EXIT_CODE)
	})

	it('refuses a file over the cap before hashing or uploading, and says how big it is', () => {
		writeFileSync(join(home, 'renders', 'big.mp4'), 'x'.repeat(1001))

		const res = run('~/renders/big.mp4', 1000)

		expect(res.status).toBe(TOO_BIG_EXIT_CODE)
		expect(res.stdout.trim()).toBe('TOOBIG 1001')
		expect(() => readFileSync(sent)).toThrow()
	})

	it('accepts a file of exactly the cap', () => {
		writeFileSync(join(home, 'renders', 'edge.mp4'), 'x'.repeat(1000))

		expect(run('~/renders/edge.mp4', 1000).status).toBe(0)
	})

	it('treats shell characters in the path as plain text', () => {
		const name = "a b'; touch pwned; '.mp4"
		writeFileSync(join(home, 'renders', name), 'x')

		const res = run(`~/renders/${name}`)

		expect(res.status).toBe(0)
		expect(() => execFileSync('test', ['-e', join(root, 'pwned')])).toThrow()
	})
})

describe('mimeTypeForFileName', () => {
	it.each([
		['render.MP4', 'video/mp4'],
		['cutlist.json', 'application/json'],
		['pack.tar.zip', 'application/zip'],
		['noextension', 'application/octet-stream'],
		['page.html', 'application/octet-stream'],
		['logo.svg', 'application/octet-stream'],
	])('maps %s to %s', (name, mime) => {
		expect(mimeTypeForFileName(name)).toBe(mime)
	})
})
