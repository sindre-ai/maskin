import type { SignalKind } from './types.js'

export const PATH_FLOOR_SCORE = 100
export const REGEX_FLOOR_SCORE = 60

export const SIGNAL_WEIGHTS: Record<
	Exclude<SignalKind, 'protected_path' | 'regex_floor_hit' | 'codeql_or_semgrep_alert'>,
	number
> = {
	diff_loc: 0,
	files_changed: 0,
	paths_auth_session: 15,
	paths_payments_billing: 20,
	paths_crypto_kms: 20,
	paths_iam_policy: 15,
	paths_migrations_ddl: 15,
	paths_iac: 15,
	paths_gha_workflows: 20,
	public_api_surface_delta: 10,
	new_deps_with_cve: 25,
	secrets_like_patterns: 30,
	missing_tests_for_logic: 10,
	top_decile_incident_file: 10,
	file_unchanged_365d: 5,
	ai_generated_marker: 5,
	squawk_blocking_lock: 15,
}

export function diffLocBucketWeight(loc: number): number {
	if (loc >= 1000) return 30
	if (loc >= 500) return 20
	if (loc >= 200) return 12
	if (loc >= 50) return 6
	return 0
}

export function filesChangedBucketWeight(count: number): number {
	if (count >= 30) return 15
	if (count >= 15) return 10
	if (count >= 5) return 5
	return 0
}

export function semgrepSeverityWeight(severity: string): number {
	switch (severity) {
		case 'CRITICAL':
			return 30
		case 'ERROR':
			return 20
		case 'WARNING':
			return 8
		case 'INFO':
			return 2
		default:
			return 0
	}
}

export const PATH_PATTERNS: Array<{ kind: SignalKind; patterns: RegExp[] }> = [
	{
		kind: 'paths_auth_session',
		patterns: [
			/(^|\/)(auth|session)([./_-]|$)/i,
			/packages\/auth\//i,
			/apps\/[^/]+\/src\/routes\/auth/i,
		],
	},
	{
		kind: 'paths_payments_billing',
		patterns: [/(payments?|billing|invoice|subscription)([./_-]|\/)/i],
	},
	{
		kind: 'paths_crypto_kms',
		patterns: [/(^|\/)(crypto|kms|encryption|secrets-manager)([./_-]|\/)/i],
	},
	{
		kind: 'paths_iam_policy',
		patterns: [/(^|\/)(iam|policy|policies|permissions?|rbac)([./_-]|\/)/i],
	},
	{
		kind: 'paths_migrations_ddl',
		patterns: [/(^|\/)migrations?\//i, /(^|\/)schema\.prisma$/i, /\.sql$/i, /drizzle\/.+\.sql$/i],
	},
	{
		kind: 'paths_iac',
		patterns: [/^infra\//i, /\.tf$/i, /\.tfvars$/i, /(^|\/)pulumi\.ya?ml$/i],
	},
	{
		kind: 'paths_gha_workflows',
		patterns: [/^\.github\/workflows\//i],
	},
]

export const SECRETS_LIKE_PATTERNS: RegExp[] = [
	/AKIA[0-9A-Z]{16}/,
	/(secret|password|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["'][^"'\n]{12,}["']/i,
	/-----BEGIN ((RSA|EC|OPENSSH|PRIVATE) )?PRIVATE KEY-----/,
	/ghp_[A-Za-z0-9]{36}/,
	/sk-[A-Za-z0-9]{32,}/,
]

export const DDL_PATTERNS: RegExp[] = [
	/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
	/\bALTER\s+TABLE\b/i,
	/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i,
	/\bADD\s+COLUMN\b/i,
]
