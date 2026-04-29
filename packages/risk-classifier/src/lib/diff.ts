import type { DiffFile } from '../types.js'

/**
 * Parse a unified diff produced by `git diff --no-color` into per-file records.
 *
 * The parser is intentionally permissive — it ignores binary-file markers and
 * extended-header lines. It does not attempt to recover from malformed input;
 * the caller passes the raw output of `git`, which is well-formed.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = []
	const lines = diff.split('\n')

	let current: DiffFile | null = null
	let patchLines: string[] = []
	let renamedFrom: string | null = null

	const flush = () => {
		if (current) {
			current.patch = patchLines.join('\n')
			files.push(current)
		}
		current = null
		patchLines = []
		renamedFrom = null
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		if (line.startsWith('diff --git ')) {
			flush()
			const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
			const path = match?.[2] ?? ''
			current = {
				path,
				status: 'modified',
				additions: 0,
				deletions: 0,
				patch: '',
			}
			continue
		}
		if (!current) continue

		if (line.startsWith('new file mode')) current.status = 'added'
		else if (line.startsWith('deleted file mode')) current.status = 'deleted'
		else if (line.startsWith('rename from ')) {
			current.status = 'renamed'
			renamedFrom = line.slice('rename from '.length)
		} else if (line.startsWith('rename to ')) {
			current.path = line.slice('rename to '.length)
		} else if (line.startsWith('Binary files ')) {
			patchLines.push(line)
		} else if (line.startsWith('@@')) {
			patchLines.push(line)
		} else if (line.startsWith('+') && !line.startsWith('+++')) {
			current.additions += 1
			patchLines.push(line)
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			current.deletions += 1
			patchLines.push(line)
		} else if (line.startsWith(' ')) {
			patchLines.push(line)
		}
	}
	flush()

	void renamedFrom
	return files
}
