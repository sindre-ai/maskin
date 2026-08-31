**Hypothesis**

The current agent memory feature is either earning its place or it's dead weight. An undecided feature is more expensive than a removed one: it costs maintenance, confuses new users, and occupies product attention without delivering value.

**Decision criteria**

- **Keep as-is:** There are active users relying on it and the experience is coherent. Evidence required: usage data showing deliberate use, not incidental.
- **Redesign:** The underlying need is real but the current shape is wrong. Evidence required: clear articulation of what problem it solves and for whom, with a concrete redesign direction.
- **Remove:** Nobody is advocating for it, usage is negligible, and the maintenance cost is real. Default path if keep/redesign cases aren't made.

**Smallest testable shape**

1. Pull usage data: how often is agent memory being read/written per session? How many distinct users are using it?
2. Ask: is anyone on the team actively building on top of this feature or advocating to keep it?
3. Make the call at define-time. Do not defer.

**Won:** A clear decision is made and executed — either usage data surfaces a real retention case, or the feature is removed from the codebase.
**Lost:** The bet closes with "we'll revisit later" — that outcome is a failure of the decision process, not a product outcome.
