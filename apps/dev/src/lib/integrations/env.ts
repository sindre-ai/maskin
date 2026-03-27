/** Read a required environment variable or throw */
export function getEnvOrThrow(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} environment variable is required`)
	return value
}
