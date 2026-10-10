<!--
Keep this template short. Delete sections that do not apply to your PR.
-->

## What this changes

<!-- One or two sentences. Link the driving bet or task if there is one. -->

## How to verify

<!-- A reviewer should be able to reproduce the check without asking. Commands, screenshots, or steps. -->

## Slack manifest scope check

Does this PR touch the Slack app manifest (`docs/integrations/slack/manifest.yml` or any file matching `**/slack-manifest.*`, `**/manifest.slack.*`, `**/slack/*manifest*`, `**/slack-app.*`)?

- [ ] No — this PR does not touch a Slack manifest.
- [ ] Yes — and I have confirmed **no forbidden ambient-capable scopes** have been added: `conversations.history`, `channels:history`, `groups:history`, `im:history`, `mpim:history`. See [docs/integrations/slack/scope-constraint.md](../docs/integrations/slack/scope-constraint.md) for the reason and the allowed reactive-only set.

<!--
The reactive-only hold is in effect while the parent bet
"Maskin in Slack waits to be asked" is live. Adding an ambient scope during
that period breaks a product commitment, not just a lint rule. If you believe
a new scope is needed, raise it as its own scope-expansion bet instead of
landing it in another PR.
-->
