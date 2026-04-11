export interface SecretPolicy {
	allowHostPatterns: string[]
}

export const SECRET_POLICIES: Record<string, SecretPolicy> = {
	ANTHROPIC_API_KEY: { allowHostPatterns: ['*.anthropic.com'] },
	OPENAI_API_KEY: { allowHostPatterns: ['*.openai.com'] },
	SLACK_TOKEN: { allowHostPatterns: ['*.slack.com'] },
	LINEAR_TOKEN: { allowHostPatterns: ['*.linear.app'] },
	GITHUB_TOKEN: { allowHostPatterns: ['*.github.com', '*.githubusercontent.com'] },
}

export interface ClassifiedEnv {
	secrets: Record<string, { value: string; policy: SecretPolicy }>
	env: Record<string, string>
}

export function classifySecrets(env: Record<string, string>): ClassifiedEnv {
	const secrets: ClassifiedEnv['secrets'] = {}
	const safeEnv: Record<string, string> = {}

	for (const [key, value] of Object.entries(env)) {
		const policy = SECRET_POLICIES[key]
		if (policy) {
			secrets[key] = { value, policy }
		} else {
			safeEnv[key] = value
		}
	}

	return { secrets, env: safeEnv }
}
