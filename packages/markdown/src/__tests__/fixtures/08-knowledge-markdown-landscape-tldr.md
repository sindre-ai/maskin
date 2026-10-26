## TL;DR

**Tiptap remains the correct pick for Maskin's use case in 2026.** No competitor has overtaken it on the specific combination Maskin needs: headless React + Markdown-canonical storage + streaming/programmatic APIs mature enough for agent-first content generation. Lexical has *no* official AI story as of April 2026 (the community `@lexical/ai` PR was rejected and removed). BlockNote has rebranded as "AI-native" but is block-based/JSON-canonical, not Markdown-canonical — switching would break the bet's zero-migration premise. Plate is the strongest philosophical alternative (free AI, shadcn-native) but ships on Slate, whose long-doc performance is weaker and API less stable. Keep Tiptap; treat the `tiptap-markdown` round-trip suite (already scoped in the bet) as the real load-bearing derisk.

## Ranked shortlist

| Rank | Library | Engine | License | Bundle (gzip) | Agent/AI-first surface | Fit |
|---|---|---|---|---|---|---|
| **1** | **Tiptap 3.x** | ProseMirror | MIT (paid Pro/Cloud) | ~103 KB starter kit; ~124 KB typical editor | AI Toolkit (beta, prod-ready) + `streamContent` primitive + Tiptap Shorthand format (−80% tokens) | ✅ Matches Maskin's stack exactly |
| 2 | Lexical | Own | MIT | ~22 KB core + plugins | No official AI; DIY via AI SDK. Extension API (v0.36.1, Sept 2025) is the modern path | Strong long-term but heavy DIY for agent-first |
| 3 | BlockNote | ProseMirror+Tiptap | MPL/MIT + `xl-ai` premium | ~150–200 KB w/ AI ext | `@blocknote/xl-ai` w/ Vercel AI SDK, streaming, tool defs, RAG | Compelling AI story, but *block/JSON canonical* — not Markdown |
| 4 | Plate | Slate | MIT (AI plugin free) | ~120–180 KB | First-party AI plugins (autocomplete/rewrite/translate), Copilot ghost text | Best free AI; Slate's API churn + perf on long docs is the tradeoff |
| 5 | Milkdown | ProseMirror + remark | MIT | ~140 KB | No first-party AI; plugin ecosystem for streaming DIY | Cleanest Markdown round-trip via remark; AI story is manual |

Newer entrants scanned but not shortlisted: **Haklex** (AI-agent-native Lexical fork w/ LiteXML for LLM-friendly serialization — early, single-maintainer); **Eddyter** (proprietary, WYSIWYG-plus-Markdown-shortcuts angle).
