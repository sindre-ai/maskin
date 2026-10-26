## Problem

Every object in Maskin is locked inside the workspace. Hans can't show a bet to a developer or stakeholder without adding them as a member. Prospects can't see what Maskin produces. There is no acquisition surface outside the product itself.

This blocks two things simultaneously: Hans's core workflow (share bet → get developer input → ship) and Maskin's growth (every person Hans shares with is a potential user who never sees the product).

## Bet

Any object in Maskin can be shared via a public URL. The shared view is read-only, branded, and rendered at maskin.io. Two CTAs on every shared page convert viewers into users: join the sharer's workspace, or create their own. Every share Hans sends is a branded acquisition touchpoint.

This is the same PLG loop that drove Notion, Figma, and Linear's early growth: the product's output is the marketing.

## What done looks like

**Sharing mechanics**
- Any object type (bet, task, insight, knowledge) can be shared externally by a workspace member
- Sharing generates a public URL: `maskin.io/share/<token>`
- Share can be revoked at any time by the owner; revoked links return a clean expired-link page
- Visibility options: public (anyone with the link) only in v1 — password-protection and domain-restricted sharing are out of scope

**Security model for external comments (required, ships with the feature)**

*Prompt injection*
- External comments are stored with trust level `untrusted`
- When an agent processes external comment content, it is always treated as sandboxed user input — never as instructions that can modify the agent's scope, goals, or behaviour
- This applies regardless of whether the agent session was triggered by a workspace member or by an external comment
- Security review required before ship: confirm no agent context path promotes external content to instruction-level trust

*Token spend*
- **By default**, external comments do not trigger agent sessions
- **Opt-in**: a workspace member can explicitly configure a trigger or loop whose event is "external comment posted on this shared object" (e.g. a feedback-collection agent). When configured, the workspace owns the token spend — this is an intentional product decision, not an exploit
- Rate-limit external comments per share token (e.g. 10 comments/hour/external account) to cap worst-case spend even when a trigger loop is active
- If comment volume on a share link is abnormal, notify the workspace admin with an option to disable comments or the trigger
