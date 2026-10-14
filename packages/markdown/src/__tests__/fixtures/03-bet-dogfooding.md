**Hypothesis**

The fastest way to find what's broken in Maskin's core experience is to use it ourselves with Hans's exact use case as the benchmark: defining and managing bets that are clear enough to share with both business and development stakeholders. If we can produce a bet that Hans would hand to a developer and a business stakeholder without explanation, the experience is at the bar. If we can't, we have a first-principles product problem, not a feature gap.

This is also an account-retention move. Coach Solutions is under organizational pressure post-Kongsberg Maritime restructuring (new CEO June 2026, running two companies from Aalborg). Hans's roadmap autonomy may be shrinking. Losing him as an engaged user during this window means losing the signal from our best proxy user.

**What Hans actually needs**

He wants to define and manage bets that are clear enough to share with both the business side and the development team. The current concern is not that the interface is confusing — it's that the *output quality* isn't high enough. The bet reads like notes, not a decision document.

**Smallest testable shape**

1. Shadow Hans (or have Sebk do it) through one real bet creation end-to-end.
2. Evaluate the output against the bar: would a developer read this and know what to build? Would a business stakeholder read this and know what they're funding?
3. Identify exactly where the agent falls short — what it should have pushed back on, what structure it should have demanded.
4. Close the gap for that one bet, then generalize.

**Won:** Hans creates a bet unassisted that he'd share directly with a developer and a stakeholder — no editing required after the fact.
**Lost:** After a fix pass, the output still needs manual cleanup before sharing.
