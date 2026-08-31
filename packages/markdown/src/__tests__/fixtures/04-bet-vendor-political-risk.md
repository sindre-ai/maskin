**Hypothesis**

Provider-neutral / BYOK is shifting from an abstract portability pitch to a concrete insurance product against vendor cutoffs. Aug 22–28 delivered three independent hard-evidence events in a single week: (1) OpenAI announced it will cut Cursor's API access Nov 12 over SpaceX ownership (Aug 28, HN #2 793 pts) — grounded in a change-of-control clause and explicit reference to Musk-company ToS violations; (2) Anthropic won a federal ruling Aug 28 that the Pentagon's supply-chain-risk blacklist was First Amendment retaliation — first legal precedent that AI vendors can (and will) maintain principled red-lines and prevail; (3) Community sweep of r/LocalLLaMA + Anthropic self-hosted docs + OpenCode UI-proxy critique (Aug 18-22) shows buyers now inspecting the *full data path*, not just the model location. Prior evidence: Anthropic already banned xAI earlier this year; four-vendor AI-teammate convergence (b2f63307) makes each vendor a swappable primitive.

Positioning consequence: Maskin's model-router + BYOK + self-host story now has a live, referenceable event (OpenAI/Cursor) plus a legal precedent (Anthropic/Pentagon) plus a data-path scrutiny theme. The pitch shifts from "portability, someday" to "insurance against your primary provider walking away, on a known-live pattern."

**Falsifiability sketch (for Strategist to shape)**

- **Supported if:** landing-page or sales copy referencing the OpenAI/Cursor cutoff and Anthropic/Pentagon precedent pulls above baseline; enterprise buyers ask about BYOK/model-router as a risk-mitigation line item; the AI-agent-control-plane / vendor-neutral category (Aramb, bb, AgentConnect, Manor AI, per f9f1faa7) keeps compounding.
- **Falsified if:** buyers treat vendor political risk as noise, cutoffs stay one-off and don't cascade, provider-neutrality pitch continues reading as theoretical.

**Distinct from existing signal bets**

- [5d985104 — Differentiate on workflow, verification, and distribution — not on raw model intelligence](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/5d985104-c818-46a5-8550-dc76d6098edb): that bet is about *why* not to compete on model layer. This bet is the *market-timing* wing — provider-neutrality is now a live buyer concern with hard-evidence events, not a general positioning stance.
- [5c5660dd — Own the governance layer for self-hosted MCP agents](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/5c5660dd-46ed-46e6-811b-7aaf71bbec7b): governance surface (tool registry, per-tool approval). This bet is provider-layer risk.
