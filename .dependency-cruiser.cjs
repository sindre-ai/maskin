/**
 * dependency-cruiser configuration for maskin.
 *
 * Rules encode the real workspace package graph from
 * `.maskin/` architecture decisions — leaves, allowed cross-package deps,
 * and browser/server runtime separation.
 *
 * Two-human PR required to edit (enforced via `.maskin/protected-paths.yml`).
 * New cross-module allowances must land here, not as per-file exceptions.
 *
 * The current-tree baseline of accepted debt lives in
 * `.maskin/fitness-baseline.json`; this file only expresses intent.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
	forbidden: [
		// ─── Built-ins ──────────────────────────────────────────────────────
		{
			name: 'no-circular',
			severity: 'error',
			comment:
				'A cycle between modules signals an architectural miss — files that cannot be reasoned about, tested, or built in isolation. Extract the shared piece into its own module.',
			from: {},
			to: { circular: true },
		},
		{
			name: 'no-orphans',
			severity: 'warn',
			comment:
				'Orphan modules are unreachable from any entry point — usually dead code left after a refactor. Delete them or wire them up.',
			from: {
				orphan: true,
				pathNot: [
					'\\.d\\.ts$',
					'(^|/)tsconfig[^/]*\\.json$',
					'(^|/)(babel|biome|vite|vitest|tailwind|postcss|drizzle|turbo|playwright)\\.config\\.[a-z]+$',
					'(^|/)__tests__/',
					'\\.(spec|test)\\.[a-z]+$',
				],
			},
			to: {},
		},
		{
			name: 'no-unreachable-from-root',
			severity: 'warn',
			comment:
				'Every source file should be reachable from an app / package / extension entry. Unreachable files are dead code and should be removed.',
			from: {
				path: [
					'^apps/[^/]+/src/(?:index|main|server)\\.(?:ts|tsx|mts)$',
					'^packages/[^/]+/src/index\\.(?:ts|tsx|mts)$',
					'^extensions/[^/]+/src/index\\.(?:ts|tsx|mts)$',
				],
			},
			to: {
				path: '^(apps|packages|extensions)/[^/]+/src/',
				pathNot: ['\\.d\\.ts$', '\\.(spec|test)\\.(?:ts|tsx|js|jsx|mjs|cjs)$', '(^|/)__tests__/'],
				reachable: false,
			},
		},
		{
			name: 'no-non-package-json',
			severity: 'error',
			comment:
				'An npm dependency is used without being declared in the nearest package.json — it will break on a clean install. Add it to the package.json that owns the importing file.',
			from: {},
			to: {
				dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
			},
		},

		// ─── Package boundaries ─────────────────────────────────────────────
		{
			name: 'shared-is-leaf',
			severity: 'error',
			comment:
				'packages/shared is a leaf — it sits at the bottom of the graph and must not import from any other workspace module.',
			from: { path: '^packages/shared/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/shared/',
			},
		},
		{
			name: 'realtime-is-leaf',
			severity: 'error',
			comment: 'packages/realtime is a leaf — it must not import from any other workspace module.',
			from: { path: '^packages/realtime/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/realtime/',
			},
		},
		{
			name: 'storage-is-leaf',
			severity: 'error',
			comment: 'packages/storage is a leaf — it must not import from any other workspace module.',
			from: { path: '^packages/storage/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/storage/',
			},
		},
		{
			name: 'db-only-uses-shared',
			severity: 'error',
			comment: 'packages/db may only depend on packages/shared.',
			from: { path: '^packages/db/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/(db|shared)/',
			},
		},
		{
			name: 'auth-only-uses-db-shared',
			severity: 'error',
			comment: 'packages/auth may only depend on packages/db and packages/shared.',
			from: { path: '^packages/auth/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/(auth|db|shared)/',
			},
		},
		{
			name: 'module-sdk-boundary',
			severity: 'error',
			comment:
				'packages/module-sdk may only depend on packages/db, packages/realtime, packages/storage, packages/shared.',
			from: { path: '^packages/module-sdk/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^packages/(module-sdk|db|realtime|storage|shared)/',
			},
		},
		{
			name: 'mcp-boundary',
			severity: 'error',
			comment:
				'packages/mcp may only depend on packages/module-sdk, packages/shared, and extensions/*.',
			from: { path: '^packages/mcp/' },
			to: {
				path: '^(apps|packages|extensions)/',
				pathNot: '^(packages/(mcp|module-sdk|shared)/|extensions/)',
			},
		},
		{
			name: 'extensions-no-apps-or-siblings',
			severity: 'error',
			comment:
				'extensions/* must not import from apps/* or from other extensions. Extensions are library-shaped modules — apps consume them, not the other way around, and extensions must stay independent of each other so they can be enabled / disabled per workspace.',
			from: { path: '^extensions/([^/]+)/' },
			to: {
				path: '^(apps/|extensions/)',
				pathNot: '^extensions/$1/',
			},
		},
		{
			name: 'web-no-server-apps',
			severity: 'error',
			comment:
				'apps/web is browser code — it must not import from apps/dev or apps/agent-server, which are server-only runtimes with Node-only dependencies (fs, dockerode, pg, …).',
			from: { path: '^apps/web/' },
			to: { path: '^apps/(dev|agent-server)/' },
		},
		{
			name: 'agent-server-no-dev',
			severity: 'error',
			comment:
				'apps/agent-server runs in a separate runtime from apps/dev — it must not import from it.',
			from: { path: '^apps/agent-server/' },
			to: { path: '^apps/dev/' },
		},
	],

	options: {
		doNotFollow: {
			path: 'node_modules',
		},
		exclude: {
			path: [
				'(^|/)node_modules/',
				'(^|/)dist/',
				'(^|/)\\.turbo/',
				'(^|/)drizzle/',
				'(^|/)build/',
				'(^|/)coverage/',
				'(^|/)playwright-report/',
				'(^|/)test-results/',
				'routeTree\\.gen\\.ts$',
			],
		},
		includeOnly: {
			path: '^(apps|packages|extensions)/',
		},
		tsPreCompilationDeps: true,
		combinedDependencies: true,
		tsConfig: {
			fileName: 'tsconfig.json',
		},
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['types', 'import', 'require', 'node', 'default'],
			mainFields: ['types', 'main', 'module'],
		},
		reporterOptions: {
			dot: {
				collapsePattern: '^(node_modules|packages|apps|extensions)/[^/]+',
			},
		},
	},
}
