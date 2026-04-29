import { z } from 'zod'

export const SKILL_VERSION = '0.1.0'

export type RiskBand = 'auto' | 'agent_recommends_human' | 'two_human_required'

export type SignalKind =
	| 'diff_loc'
	| 'files_changed'
	| 'paths_auth_session'
	| 'paths_payments_billing'
	| 'paths_crypto_kms'
	| 'paths_iam_policy'
	| 'paths_migrations_ddl'
	| 'paths_iac'
	| 'paths_gha_workflows'
	| 'public_api_surface_delta'
	| 'new_deps_with_cve'
	| 'secrets_like_patterns'
	| 'missing_tests_for_logic'
	| 'top_decile_incident_file'
	| 'file_unchanged_365d'
	| 'ai_generated_marker'
	| 'codeql_or_semgrep_alert'
	| 'protected_path'
	| 'regex_floor_hit'
	| 'kill_switch'
	| 'squawk_blocking_lock'

export interface SignalHit {
	kind: SignalKind
	weight: number
	evidence: string
}

export interface DiffFile {
	path: string
	status: 'added' | 'modified' | 'deleted' | 'renamed'
	additions: number
	deletions: number
	patch: string
}

export interface ClassifierInput {
	commit_sha: string
	files: DiffFile[]
	protected_paths: string[]
	regex_floors: RegexFloor[]
	hot_tables: string[]
	kill_switch: boolean
	new_deps_with_cve?: string[]
	semgrep_alerts?: SemgrepAlert[]
	incident_density?: Record<string, number>
	file_age_days?: Record<string, number>
	squawk_findings?: SquawkFinding[]
	ai_generated_marker?: boolean
	missing_tests_for_logic?: boolean
	public_api_surface_delta?: number
}

export interface RegexFloor {
	pattern: string
	description: string
}

export interface SemgrepAlert {
	rule_id: string
	severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
	path: string
	line: number
}

export interface SquawkFinding {
	rule: string
	severity: 'warning' | 'error'
	path: string
	hot_table_hit: boolean
}

export interface ClassifierVerdict {
	skill_version: string
	commit_sha: string
	score: number
	band: RiskBand
	signals: SignalHit[]
	floors_applied: SignalHit[]
	kill_switch_active: boolean
	deterministic_seed: string
}

export const RegexFloorSchema = z.object({
	pattern: z.string().min(1),
	description: z.string().default(''),
})

export const RegexFloorsFileSchema = z.object({
	regex_floors: z.array(RegexFloorSchema).default([]),
})

export const ProtectedPathsFileSchema = z.object({
	protected_paths: z.array(z.string().min(1)).default([]),
})

export const HotTablesFileSchema = z.object({
	hot_tables: z.array(z.string().min(1)).default([]),
})
