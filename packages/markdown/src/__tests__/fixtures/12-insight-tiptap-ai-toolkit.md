Tiptap's AI Toolkit graduated to beta with server-side variant added (previously client-only). Adapters for Vercel AI SDK v4/v5, LangChain.js, OpenAI, Anthropic, and Mastra ship in-box. Toolkit exposes `tiptapEdit`, `tiptapRead`, `editThreads` as LLM tools with token-optimized JSON compression (Tiptap Shorthand: −80% tokens). Server variant runs async workflows detached from the browser session — user closes tab, AI keeps editing.

**Why it matters for Maskin:** No competing editor library ships this specific pattern (document-as-tools, provider-agnostic, streaming-aware) with anywhere near this maturity in 2026. Lexical rejected the equivalent PR (#8331). BlockNote's is comparable but block/JSON-canonical. This is the load-bearing evidence that Tiptap is still the right pick for agent-first content in 2026.

Sources: https://tiptap.dev/product/ai-toolkit; https://tiptap.dev/blog/release-notes/ai-toolkit-now-in-beta; https://tiptap.dev/blog/release-notes/recap-q1-2026
