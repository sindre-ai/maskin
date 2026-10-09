import type { ClassifierInput, DiffFile, SignalHit } from './types.js'

export const LOC_GATE_THRESHOLD = 1000
export const DB_CODE_LINES_GATE_THRESHOLD = 2

const DB_FILE_PATTERNS: RegExp[] = [
	/\.sql$/i,
	/(^|\/)schema\.prisma$/i,
	/^packages\/db\/src\/schema\.ts$/i,
]

export function isDbFile(path: string): boolean {
	return DB_FILE_PATTERNS.some((re) => re.test(path))
}

function isCommentOrBlank(content: string, path: string): boolean {
	const text = content.trim()
	if (text === '') return true
	if (text.startsWith('/*') || text.startsWith('*')) return true
	return path.toLowerCase().endsWith('.sql') ? text.startsWith('--') : text.startsWith('//')
}

/** Added + removed lines in a patch that are neither blank nor comments. */
export function countCodeLines(file: DiffFile): number {
	let count = 0
	for (const line of file.patch.split('\n')) {
		if (!(line.startsWith('+') || line.startsWith('-'))) continue
		if (!isCommentOrBlank(line.slice(1), file.path)) count += 1
	}
	return count
}

/**
 * The only conditions that block a PR: more than 1000 changed lines overall, or
 * more than 2 lines of real code changed in database files.
 */
export function collectGates(input: Pick<ClassifierInput, 'files'>): SignalHit[] {
	const gates: SignalHit[] = []

	const totalLoc = input.files.reduce((acc, f) => acc + f.additions + f.deletions, 0)
	if (totalLoc > LOC_GATE_THRESHOLD) {
		gates.push({
			kind: 'loc_gate',
			weight: 0,
			evidence: `${totalLoc} lines changed (limit ${LOC_GATE_THRESHOLD})`,
		})
	}

	const dbFiles = input.files
		.filter((f) => isDbFile(f.path))
		.map((f) => ({ path: f.path, codeLines: countCodeLines(f) }))
	const dbCodeLines = dbFiles.reduce((acc, f) => acc + f.codeLines, 0)
	if (dbCodeLines > DB_CODE_LINES_GATE_THRESHOLD) {
		const changed = dbFiles.filter((f) => f.codeLines > 0).map((f) => f.path)
		gates.push({
			kind: 'db_change_gate',
			weight: 0,
			evidence: `${dbCodeLines} code lines changed in database files (limit ${DB_CODE_LINES_GATE_THRESHOLD}): ${changed.join(', ')}`,
		})
	}

	return gates
}
