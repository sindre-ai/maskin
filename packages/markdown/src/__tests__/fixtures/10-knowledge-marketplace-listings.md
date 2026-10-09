## TL;DR
Yes, marketplace listings are a real acquisition channel for a product shaped like Maskin — but the ROI is dramatically asymmetric across marketplaces, and the framing of "we need connectors anyway → free growth" understates the maintenance tax. **Rank order for Maskin: (1) Slack Marketplace [proven playbook, ICP overlap, no rev share], (2) MCP registry + sub-registries [on-strategy, cheap to publish, discovery still early], (3) Atlassian Marketplace [only if we make it complement Jira rather than compete], (4) HubSpot Marketplace [big surface but ICP mismatch — hold], (5) Notion — templates gallery, not the integrations gallery [different game, SEO play], (6) Figma Community — skip for now [designer ICP, not PM].**

## Key findings

### 1. The three types of "marketplace" have completely different economics — conflating them is the #1 early mistake
- **App directory** (Slack, HubSpot, Notion integrations, Freshworks): discovery surface for that platform's existing customers → trials + stickiness, small-to-mid deals, usually no rev share.
- **App store** (Shopify, Atlassian, Figma Community with paid resources): real commercial channel with rev share (Atlassian: 80-84%, Figma: pays via Stripe), you live under their review + policy rules.
- **Cloud marketplace** (AWS / Azure / GCP): procurement plumbing for enterprise deals, NOT a discovery channel. Treating it as marketing disappoints ([eChai GTM breakdown](https://echai.ventures/gtm/gtm-channel-ecosystem/app-store-app-directory-cloud-marketplace-which-of-these-actually-matters-for-us)).

### 2. Slack Marketplace has the deepest documented playbook for products shaped like Maskin
Repeat pattern across five founder-sourced case studies:
- **Standuply** — featured in March 2017 → **750 signups in 2 weeks**, 1,000 teams; scaled to $80K/mo. "The Slack App Directory is the number-one driving factor for an early-stage Slack bot." ([Slack Developer Blog](https://medium.com/slack-developer-blog/from-zero-to-25-000-mo-bf7caddea44d), [FirstMRR](https://first-mrr.com/study/standuply))
- **Tettra** — one of first 50 apps in directory → hundreds of signups/month; $25K MRR + $940K seed raised on that traction. Directory + SEO were their only two channels ([Leadfeeder](https://www.leadfeeder.com/blog/growth-strategy-tettra/)).
- **Statsbot** — 20,000 teams hired them via directory + Product Hunt + Slack search.
- **Donut** — 10M+ connections across 20,000 companies via Slack Directory ([Slack blog](https://slack.com/blog/developers/donut-built-slack-first-business)).
- **Organize.app** — **100% of paying customers came from Slack marketplace search** — pure keyword-optimized listing, no paid acquisition ([FirstMRR](https://first-mrr.com/study/organize-app)).

**Why it works for Slack specifically:** ~2,650 public listings, no ratings/reviews so wording carries proportionally more weight, keyword-optimized listings rank organically, PM buyers live in Slack ([AppRanks Slack analysis](https://appranks.io/keyword-finder/slack)). Slack also exposes `isAiApp` / `isAgentApp` / MCP-server flags on listings — new, sparsely claimed shelves that fit Maskin's positioning.

**Cost of admission:** app must run in multiple real workspaces before submission; review process; professional support required; de-list risk if you go stale. Review typically takes weeks.
