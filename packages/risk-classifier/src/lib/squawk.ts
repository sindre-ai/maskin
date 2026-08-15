import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type { DiffFile, SquawkFinding } from '../types.js'

const SQL_HOT_TABLE_RE = (table: string) =>
	new RegExp(`\\b${table.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i')

/**
 * Run `squawk` on every modified .sql file. If the binary is not available the
 * adapter degrades gracefully — the absence of a finding is *not* the same as
 * an explicit pass, but it matches the deterministic-output contract.
 */
export function runSquawkOnSqlFiles(
	files: DiffFile[],
	repoRoot: string,
	hotTables: string[],
): SquawkFinding[] {
	const sqlFiles = files.filter((f) => f.path.endsWith('.sql') && f.status !== 'deleted')
	if (sqlFiles.length === 0) return []

	const binaryAvailable = spawnSync('squawk', ['--version']).status === 0
	if (!binaryAvailable) return []

	const findings: SquawkFinding[] = []
	for (const file of sqlFiles) {
		const result = spawnSync('squawk', ['--reporter=json', path.join(repoRoot, file.path)], {
			encoding: 'utf8',
		})
		if (result.status !== 0 && result.status !== 1) continue
		const parsed = parseSquawkJson(result.stdout, file.path, hotTables)
		findings.push(...parsed)
	}
	return findings
}

function parseSquawkJson(stdout: string, filePath: string, hotTables: string[]): SquawkFinding[] {
	let json: unknown
	try {
		json = JSON.parse(stdout)
	} catch {
		return []
	}
	if (!Array.isArray(json)) return []
	const out: SquawkFinding[] = []
	for (const raw of json) {
		if (typeof raw !== 'object' || raw === null) continue
		const record = raw as Record<string, unknown>
		const rule = typeof record.rule_name === 'string' ? record.rule_name : 'unknown'
		const level = typeof record.level === 'string' ? record.level : 'warning'
		const severity: 'warning' | 'error' = level === 'error' ? 'error' : 'warning'
		const messageBlob = JSON.stringify(record).toLowerCase()
		const hot_table_hit = hotTables.some((t) => SQL_HOT_TABLE_RE(t).test(messageBlob))
		out.push({ rule, severity, path: filePath, hot_table_hit })
	}
	return out
}
