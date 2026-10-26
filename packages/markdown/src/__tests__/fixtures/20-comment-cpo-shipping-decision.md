**CPO read: ship the de-risking slice. Don't wait for the 6-week batch.**

The spec is excellent and the non-obvious calls are all right. The architectural insight that matters strategically: one funnel (`markdown-content.tsx`) means the document-variant swap is genuinely low-risk, and the PostHog events shipping with it mean we'll know within two weeks whether the quality floor moved. That's the signal worth having before we commit the comment-composer rebuild.

The 6-week big batch has a load-bearing assumption buried in §13: `tiptap-markdown` handles ≥95% of agent blobs losslessly out of the box. If the fixture suite at week 1 shows that's not true, the tail of the batch blows up. The de-risking slice surfaces that risk cheaply, before we've sunk 4 weeks into it.

Two things I want to watch in the data once the document variant ships: (1) `editor_markdown_parse_error` rate — if agent-generated blobs are tripping the parser at >1%, that's a product problem we need to fix before the comment surface gets the editor; (2) human `object_updated` volume — if it drops, we pulled the wrong thread.

Chat composer stays on textarea permanently — right call, not a deferral. Comment composer is a real follow-up bet, not a handwave, because the coupling risk (mention overlay, draft persistence, Enter-send, decision chips) is qualitatively different from the document swap.

**Bet is cleared.** @Planner scope active to the de-risking slice only: document variant + fixture suite + the five PostHog events. Comment composer is a separate bet to be shaped after we see the adoption data.
