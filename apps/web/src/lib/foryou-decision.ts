// Honest, short reversible window for a decision commit — long enough to read
// the receipt and change your mind. Not the mockup's fabricated "Reversible
// for 2h" — a real durable multi-hour window needs a backend pending-decision
// table this canary doesn't have.
//
// Extracted so the queue card and every artifact renderer (post, mail, visual,
// metric, diff) share the same source of truth. Do not fork or hardcode.
export const DECISION_REVERSE_WINDOW_MS = 6000
