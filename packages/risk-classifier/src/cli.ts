import path from 'node:path'
import { parseArgs } from 'node:util'
import { classify } from './classifier.js'
import { loadMaskinConfig } from './lib/config.js'
import { readDiffFromGit, resolveCommitSha } from './lib/git.js'
import { loadIncidentDensityFromFile } from './lib/incidents.js'
import { runSemgrepDiff } from './lib/semgrep.js'
import { runSquawkOnSqlFiles } from './lib/squawk.js'
import { checkRunConclusion, renderRiskScoreBlock } from './render.js'
import type { ClassifierInput } from './types.js'

interface CliOptions {
	base: string
	head: string
	repo: string
	killSwitch: boolean
	incidentDensityFile?: string
	cveDeps: string[]
	missingTests: boolean
	aiGenerated: boolean
	publicApiDelta: number
	output: 'markdown' | 'json' | 'check-run'
}

export function parseCliArgs(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			base: { type: 'string' },
			head: { type: 'string' },
			repo: { type: 'string' },
			'kill-switch': { type: 'boolean', default: false },
			'incident-density': { type: 'string' },
			'cve-dep': { type: 'string', multiple: true },
			'missing-tests': { type: 'boolean', default: false },
			'ai-generated': { type: 'boolean', default: false },
			'public-api-delta': { type: 'string', default: '0' },
			output: { type: 'string', default: 'markdown' },
		},
		strict: true,
	})

	const base = required(values.base, '--base')
	const head = required(values.head, '--head')
	const repo = path.resolve(values.repo ?? process.cwd())
	const output = parseOutput(values.output)

	const publicApiDeltaRaw = Number(values['public-api-delta'])
	const publicApiDelta =
		Number.isFinite(publicApiDeltaRaw) && publicApiDeltaRaw >= 0 ? publicApiDeltaRaw : 0

	return {
		base,
		head,
		repo,
		killSwitch: Boolean(values['kill-switch']),
		incidentDensityFile: values['incident-density'],
		cveDeps: (values['cve-dep'] as string[] | undefined) ?? [],
		missingTests: Boolean(values['missing-tests']),
		aiGenerated: Boolean(values['ai-generated']),
		publicApiDelta,
		output,
	}
}

function required(v: string | undefined, name: string): string {
	if (!v) throw new Error(`${name} is required`)
	return v
}

function parseOutput(v: unknown): CliOptions['output'] {
	if (v === 'json' || v === 'check-run') return v
	return 'markdown'
}

export function runCli(argv: string[]): { exitCode: number; stdout: string } {
	const opts = parseCliArgs(argv)
	const config = loadMaskinConfig(opts.repo)
	const files = readDiffFromGit(opts.base, opts.head, opts.repo)
	const commitSha = resolveCommitSha(opts.head, opts.repo)
	const squawkFindings = runSquawkOnSqlFiles(files, opts.repo, config.hot_tables)
	const semgrepAlerts = runSemgrepDiff(opts.base, opts.head, opts.repo)
	const incidentDensity = opts.incidentDensityFile
		? loadIncidentDensityFromFile(opts.incidentDensityFile)
		: undefined

	const input: ClassifierInput = {
		commit_sha: commitSha,
		files,
		protected_paths: config.protected_paths,
		regex_floors: config.regex_floors,
		hot_tables: config.hot_tables,
		kill_switch: opts.killSwitch,
		new_deps_with_cve: opts.cveDeps,
		semgrep_alerts: semgrepAlerts,
		squawk_findings: squawkFindings,
		incident_density: incidentDensity,
		ai_generated_marker: opts.aiGenerated,
		missing_tests_for_logic: opts.missingTests,
		public_api_surface_delta: opts.publicApiDelta,
	}

	const verdict = classify(input)
	const stdout =
		opts.output === 'json'
			? JSON.stringify(verdict, null, 2)
			: opts.output === 'check-run'
				? JSON.stringify(checkRunConclusion(verdict), null, 2)
				: renderRiskScoreBlock(verdict)

	const exitCode = verdict.band === 'auto' ? 0 : verdict.band === 'agent_recommends_human' ? 1 : 2
	return { exitCode, stdout }
}
