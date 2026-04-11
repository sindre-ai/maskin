import type * as Preset from '@docusaurus/preset-classic'
import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

const config: Config = {
	title: 'Maskin',
	tagline: 'The open-source AI agent workspace for product teams',
	favicon: 'img/favicon.ico',

	future: {
		v4: true,
	},

	url: 'https://docs.maskin.ai',
	baseUrl: '/',

	organizationName: 'sindre-ai',
	projectName: 'maskin',

	onBrokenLinks: 'throw',

	i18n: {
		defaultLocale: 'en',
		locales: ['en'],
	},

	presets: [
		[
			'classic',
			{
				docs: {
					sidebarPath: './sidebars.ts',
					editUrl: 'https://github.com/sindre-ai/maskin/tree/main/docs-site/',
					routeBasePath: '/',
				},
				blog: false,
				theme: {
					customCss: './src/css/custom.css',
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		colorMode: {
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: 'Maskin',
			items: [
				{
					type: 'docSidebar',
					sidebarId: 'docsSidebar',
					position: 'left',
					label: 'Docs',
				},
				{
					href: 'https://github.com/sindre-ai/maskin',
					label: 'GitHub',
					position: 'right',
				},
			],
		},
		footer: {
			style: 'dark',
			links: [
				{
					title: 'Docs',
					items: [
						{ label: 'Quick Start', to: '/quick-start' },
						{ label: 'Core Concepts', to: '/core-concepts' },
						{ label: 'API Reference', to: '/api-reference' },
					],
				},
				{
					title: 'Community',
					items: [
						{
							label: 'GitHub',
							href: 'https://github.com/sindre-ai/maskin',
						},
						{
							label: 'Contributing',
							href: 'https://github.com/sindre-ai/maskin/blob/main/CONTRIBUTING.md',
						},
					],
				},
			],
			copyright: `Copyright © ${new Date().getFullYear()} Maskin. Apache 2.0 License.`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
			additionalLanguages: ['bash', 'json'],
		},
	} satisfies Preset.ThemeConfig,
}

export default config
