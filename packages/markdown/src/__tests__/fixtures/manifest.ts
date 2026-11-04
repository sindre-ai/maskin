// Provenance table for every fixture in this directory.
//
// Every fixture MUST be a verbatim copy-paste from a live object in the
// Maskin workspace (bet body, task body, knowledge body, or comment). See
// `README.md` in this directory for the fixture-add procedure. If you added a
// fixture without adding a row here, the roundtrip suite will fail — the
// missing-provenance check exists so a synthetic example can't slip in
// unnoticed under the "no-synthesis" AC.

export interface FixtureProvenance {
	/** Filename inside `packages/markdown/src/__tests__/fixtures/`. */
	file: string
	/** What kind of live object this content was copied from. */
	kind: 'bet' | 'task' | 'knowledge' | 'insight' | 'content' | 'comment'
	/** URL of the source object at the time the fixture was captured. */
	sourceUrl: string
	/** Short human-readable label for test output. */
	label: string
}

export const FIXTURES: readonly FixtureProvenance[] = [
	{
		file: '01-bet-design-implementation-finishes.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/953a5fe7-bd3b-43d9-a2b8-eb7527381545',
		label: 'Bet: Design implementation finishes — September 2026',
	},
	{
		file: '02-bet-agent-memory.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/073788ad-a8ba-424c-94cd-83798c37eb74',
		label: 'Bet: Agent memory — decide keep/redesign/remove',
	},
	{
		file: '03-bet-dogfooding.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/c2128b52-9c26-4658-b2a6-2f50411a3b24',
		label: 'Bet: Dogfooding',
	},
	{
		file: '04-bet-vendor-political-risk.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/6bc6b795-c7ce-402c-a525-08c054ceafab',
		label: 'Bet: Vendor political risk / BYOK positioning',
	},
	{
		file: '05-bet-external-object-sharing.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d611d12a-c37e-4801-8aaf-5fa4fc0f2837',
		label: 'Bet: External object sharing (PLG growth loop)',
	},
	{
		file: '06-bet-rich-markdown-editor.md',
		kind: 'bet',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01',
		label: 'Bet: Rich Markdown editor across Maskin',
	},
	{
		file: '07-knowledge-september-2026.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/99191eda-f9be-4a66-91bb-7f9412ab4843',
		label: 'Knowledge: September 2026 — Goals, Bets & Product Plan',
	},
	{
		file: '08-knowledge-markdown-landscape-tldr.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/11da756f-1c27-48b2-84fd-2e3bc7efd667',
		label: 'Knowledge: Markdown editor library landscape 2026 — TL;DR + table',
	},
	{
		file: '09-knowledge-markdown-landscape-recommendation.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/11da756f-1c27-48b2-84fd-2e3bc7efd667',
		label: 'Knowledge: Markdown landscape — recommendation section',
	},
	{
		file: '10-knowledge-marketplace-listings.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/ae183cf8-679a-4724-a4ae-577052aae028',
		label: 'Knowledge: SaaS marketplace listings ROI',
	},
	{
		file: '11-insight-lexical-ai-rejected.md',
		kind: 'insight',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/c37c1727-c13d-43bb-821d-4c3abb1ec2c1',
		label: 'Insight: Lexical rejected @lexical/ai PR',
	},
	{
		file: '12-insight-tiptap-ai-toolkit.md',
		kind: 'insight',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/ad6168aa-ec46-469e-8065-4a77cf50405f',
		label: 'Insight: Tiptap AI Toolkit beta',
	},
	{
		file: '13-insight-blocknote-json.md',
		kind: 'insight',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/ced70c27-ed91-4f8f-accc-2cda1f05c746',
		label: 'Insight: BlockNote is JSON-canonical, not Markdown',
	},
	{
		file: '14-insight-doctrine-cluster-with-chart.md',
		kind: 'insight',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/74b11c56-ff32-4523-be0e-4fed973c1884',
		label: 'Insight: Doctrine cluster post-live pass (contains ```chart block)',
	},
	{
		file: '15-content-composable-agents-brief.md',
		kind: 'content',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/44fcb21c-79ff-49e8-a5b3-067481b8282c',
		label: 'Content brief: composable AI agents vs AI employees (contains hard breaks)',
	},
	{
		file: '16-tech-spec-package-list.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/4d252834-e92d-4d9e-bb47-ac6ab4848209',
		label: 'Tech spec §2 — package + extension list (```jsonc code block)',
	},
	{
		file: '17-tech-spec-fidelity-table.md',
		kind: 'knowledge',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/4d252834-e92d-4d9e-bb47-ac6ab4848209',
		label: 'Tech spec §3 — round-tripping + fidelity table (escaped chars in cells)',
	},
	{
		file: '18-task1-body-split-markdown-content.md',
		kind: 'task',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/67a0d3c4-675f-4133-95a5-24702cee0d48',
		label: 'Task: Split markdown-content.tsx and wire Tiptap editor foundation',
	},
	{
		file: '19-comment-planner-breakout.md',
		kind: 'comment',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01',
		label: 'Comment: Planner breaks bet into 6 tasks',
	},
	{
		file: '20-comment-cpo-shipping-decision.md',
		kind: 'comment',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01',
		label: 'Comment: CPO clears bet — ship de-risking slice',
	},
	{
		file: '21-comment-architect-tech-spec-summary.md',
		kind: 'comment',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01',
		label: 'Comment: Architect summarizes attached tech spec',
	},
	{
		file: '22-insight-observability-jtbd.md',
		kind: 'insight',
		sourceUrl:
			'https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/ff0f6eec-b8ef-4796-b1be-ca98e15c7b2e',
		label: 'Insight: Observability JTBD SERP-consensus',
	},
] as const
