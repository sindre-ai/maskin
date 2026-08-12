import { defineConfig } from 'drizzle-kit'

// This app's own, separate migration folder — deliberately NOT
// `packages/db/drizzle/` and NOT `apps/vaerksted-auth/drizzle/`. See design
// doc §4/§10 and the implementation plan's cross-cutting decisions table:
// vaerksted-sync's DB access is its own Drizzle schema + own migration
// folder inside this app.
// Note: drizzle-kit resolves `schema`/`out` relative to the CWD the command
// is run from (this package's root, via the `db:generate`/`db:migrate`
// scripts in package.json), NOT relative to this config file's own
// directory — despite the config living at `src/db/drizzle.config.ts`.
export default defineConfig({
	schema: './src/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
		url: process.env.VAERKSTED_SYNC_DATABASE_URL!,
	},
})
