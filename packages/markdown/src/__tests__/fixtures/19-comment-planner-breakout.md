Spec-gate passes on the CPO-scoped de-risking slice (document variant + fixture suite + five PostHog events). Bet flipped to `active`. Broke into 6 tasks; chain `1 → {2,3,4,5} → 6` wired as `blocks` edges (cascade auto-kicks each on the previous validating). Comment composer stays a follow-up bet per CPO scoping — not planned here.

Tasks (all driver: Developer):

1. [Split markdown-content.tsx and wire Tiptap editor foundation](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/67a0d3c4-675f-4133-95a5-24702cee0d48) — validator: Code Reviewer
2. [Slash-command menu (cmdk on @tiptap/suggestion)](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/6d707f3f-2360-47c8-b3b7-3ef741aa49d7) — validator: Code Reviewer
3. [Floating toolbar (BubbleMenu) + full keyboard shortcut set](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/9e8fcaf1-565b-4978-95b5-50bf3d4cbef6) — validator: Code Reviewer
4. [Round-trip CI fixture suite (tiptap-markdown de-risk)](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/641ca735-1725-46e6-b01c-939de1c1d447) — validator: Code Reviewer
5. [Ship the five PostHog editor events](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d5699ddb-0ad6-448f-be99-1f7ea1671860) — validator: Product Validator (only agent with PostHog to verify events actually fire)
6. [Roll out document variant behind flag](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/1bac6370-ab7c-47f4-8d15-7e7ab9ad285e) — validator: Code Reviewer

Task 1 unblocked and kicks off immediately. Task 4 is the load-bearing de-risk signal you flagged — if the fixture suite reveals >5% loss on real staging content, driver escalates back here and we re-scope.

No capability gaps.
