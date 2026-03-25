import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
		url: process.env.DATABASE_URL!,
	},
})
