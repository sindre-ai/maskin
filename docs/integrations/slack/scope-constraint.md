# Slack app OAuth scopes — reactive-only hold

While the [Maskin in Slack waits to be asked — no ambient surfacing or stale-thread chase](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/32c0d1d7-972f-47af-b87d-4696a94b637e) bet is live, the Slack app is on a **reactive-only hold**. Maskin only reads what it was explicitly @mentioned in or DMed — it does not sit in channels and read ambient traffic, and it does not chase stale threads.

This document is the enforceable side of that decision. Any PR that adds ambient-capable OAuth scopes to the [Slack app manifest](./manifest.yml) violates the hold and must be blocked.

## Allowed reactive-only scopes

These are the OAuth scopes needed to *react* to explicit user intent — an @mention, a DM, a reaction on Maskin's own message. They read only what the user directed at Maskin.

Bot token (`xoxb-`):
- `app_mentions:read` — receive `app_mention` events. This is the primary reactive trigger.
- `chat:write` — reply to the mention.
- `chat:write.customize` — per-agent identity subscript on replies.
- `im:read`, `im:write` — receive and respond to DMs.
- `channels:read`, `groups:read`, `mpim:read` — resolve channel/group metadata when the mention lands there. Metadata only — these do **not** grant history access.
- `users:read` — resolve the mentioner's name and profile.
- `reactions:read`, `reactions:write` — react to Maskin's own messages when a user reacts.

Anything outside this set needs an explicit scope-expansion bet with human sign-off.

## Forbidden ambient-capable scopes

These scopes let Maskin read channel or DM history it was not explicitly addressed in. **Do not add any of them to the manifest while the reactive-only hold is in effect.**

- `conversations.history`
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`

The reason is not technical, it is a product commitment: the parent bet's premise is that Maskin only surfaces when asked. Ambient history access — even if unused at runtime — breaks that promise the moment it appears in the install prompt a user sees when authorising the app.

## Pre-existing state (audit note)

The current `manifest.yml` on `main` was authored under the earlier `bet/slack-trust-surface` initiative and still lists `channels:history`, `groups:history`, `im:history`, `mpim:history` under `oauth_config.scopes.bot`, plus history scopes under the user token. That predates this hold. Reconciling those pre-existing scopes with the reactive-only commitment — either by trimming them or by documenting a runtime guard that prevents their use — is follow-up work that belongs to the parent bet's owners, not this guardrail.

The guardrail here is forward-looking: **no new ambient scopes get added while the hold is in effect.**

## How this is enforced

- The [pull request template](../../.github/pull_request_template.md) carries a Slack-manifest checkbox: any PR touching the manifest must confirm no forbidden ambient scopes have been added.
- [CODEOWNERS](../../CODEOWNERS) routes any change to a Slack-manifest-shaped file to Magnus for human review.
- This document is the reference the reviewer checks against.

## When this hold ends

When the parent bet closes with a verdict that lifts the reactive-only hold, delete this document (or edit it to reflect the new posture) and remove the PR-template checkbox. Until then, treat any scope-expansion PR as needing an explicit human decision, not an implementation detail.
