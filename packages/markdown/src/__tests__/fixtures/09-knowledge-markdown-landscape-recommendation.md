## AI-native evolution — what "agent-first" means in 2026

1. **Streaming primitives are table stakes.** Tiptap's `streamContent`, BlockNote's `streamTool`, Plate's AI plugins, and Lexical's community `insertRawText`/`$convertFromMarkdownString` patterns all target token-by-token document insertion.
2. **Tool-call APIs are the frontier.** Tiptap AI Toolkit (`tiptapEdit`, `tiptapRead`, `editThreads`) and BlockNote (`aiDocumentFormats.html.getStreamToolsProvider`) expose the document as tools for LLM function calling — this is where 2026 competition is real. Lexical PR #8331 tried the same pattern; rejection means it's a year behind.
3. **Token-optimized document formats are emerging.** Tiptap Shorthand claims 80% token reduction vs JSON. Haklex's LiteXML makes the same bet with XML. This matters as documents get long and agents get chatty — a workspace-scale editor bill can hinge on it.
4. **Human-in-the-loop review is standardizing.** Tracked changes / diff overlays on AI edits (Tiptap Track Changes, BlockNote's interactive suggestions, Plate's Copilot ghost text) are becoming the expected UX for accept/reject flows.
5. **AI-SDK (Vercel) is the de-facto interop layer.** Every serious editor now integrates with it. Any editor Maskin picks should work with the AI SDK it already uses or plans to use.

## Recommendation

**Ship Tiptap as planned.** The provisional choice validates on evidence:

- Tiptap 3.x + `tiptap-markdown` is the only mature combination that keeps Markdown as the canonical format (Maskin's stated invariant) *and* has production-ready streaming + tool-call APIs for agent-first content.
- The paid-vs-free AI story is *not* a blocker for v1 as scoped — the bet doesn't include AI editor features, only agent-generated static Markdown rendering + light human editing. `streamContent` (free, in `@tiptap/core`) is the only AI-adjacent primitive v1 needs.
- The real risk called out in the bet — `tiptap-markdown` community maintenance — is what to watch. The scoped fork-fallback plan is the right derisk.
- Do *not* re-evaluate to BlockNote unless the team is willing to convert canonical storage from Markdown-string to BlockNote-JSON tree. That's a much bigger bet than "pick the editor".
- Do *not* re-evaluate to Plate unless free AI plugins become a v2 requirement AND the team is willing to accept Slate's long-doc perf and API-churn tradeoffs.
- Revisit if: (a) Tiptap makes AI Toolkit a required dependency of the core editor, (b) `tiptap-markdown` is abandoned before Maskin can adopt the fork, or (c) v2 needs deep multiplayer + AI review flows that Tiptap Cloud pricing makes uneconomic — in which case Plate + Liveblocks is the credible alternative.
