# Privacy policy — draft copy

⚠️ **This copy is not live on maskin.io today.** Apple's App Store review requires a public Privacy Policy URL — no policy, no approval. This draft is the source-of-truth text to publish at `https://maskin.io/privacy` before the submission goes in. Hosting the page is a blocking gate on `pre-submission-checklist.md`.

The copy below is grounded in what the app actually collects (see `app-privacy.md`). If a code change alters what leaves the device — new SDK, new field, new destination — this draft must be updated in the same PR and the hosted copy re-published before the next binary ships.

---

## Draft to publish

Publish the block below verbatim at `https://maskin.io/privacy`. Also link to it from the main site nav and the footer — Apple sometimes rejects a policy that's only reachable at the deep URL.

```
Privacy Policy

Last updated: <YYYY-MM-DD when the page goes live>

Maskin (the "Service") is a workspace for reviewing agent-generated recommendations and acting on them. This policy explains what data we collect, why, how we store it, and the choices you have over it. It applies to both the Maskin web app at maskin.io and the Maskin mobile app for iOS and iPad.

1. Who runs the Service

Maskin is operated by <legal entity name and country of registration>. Contact us at privacy@maskin.io for any privacy question.

2. What we collect

We collect only what the Service needs to work for you.

- Your email address. You give this to us when you sign in. We use it to send the magic link that authenticates you, and to identify your workspace membership.
- The content you and your workspace create. Bets, tasks, "For You" cards, comments, and any other object you create or interact with while signed in. This is stored on our own servers, in your own workspace.
- Your workspace and user identifiers. Non-guessable random identifiers ("workspace_id", "actor_id") that scope the content above to you and the workspace you belong to.
- Product usage data. Page views and named product events, captured through PostHog (a first-party analytics service we run for our own product analytics). Analytics are configured for "identified users only" — visitors who never sign in are not profiled — and we do not enable PostHog's automatic click-tracking.
- Push notification tokens (mobile app only). When you enable push notifications on the mobile app, iOS provides Maskin with an anonymous device token issued by Apple. We use it exclusively to deliver notifications to your device. It cannot be used to contact you outside the app.

We do not collect precise location, contacts, photos, health data, financial data, browsing history outside the Service, or any category of sensitive personal information.

3. What we do not collect and do not do

- We do not run third-party advertising SDKs.
- We do not sell or share your data with data brokers.
- We do not use your workspace content or messages to train third-party AI models. When you invoke a Maskin agent, we send only what the agent needs to complete its task to the AI provider you have configured for that agent, under a data-processing agreement with that provider.
- We do not link data collected in the Service to data collected in other companies' apps or websites for advertising or brokerage purposes. Under Apple's App Store definitions, we do not "track" you.

4. How we use what we collect

- To provide the Service (sign you in, load your workspace, render the For You feed, deliver push notifications).
- To improve the product (aggregate usage analytics tell us which surfaces are used and which are not).
- To fulfil legal obligations where we are required to (tax, accounting, responding to lawful requests).

We do not process your data for automated decision-making with legal or similarly significant effects on you.

5. Who we share it with

- The AI providers you configure for Maskin agents (OpenAI, Anthropic, Google, and any provider you connect). We send only what the agent needs to complete its task, under a data-processing agreement with each provider.
- Sub-processors necessary to run the Service — currently: our cloud host, our transactional email provider, and PostHog for analytics. We keep the current sub-processor list on our website; email privacy@maskin.io for the up-to-date list.
- Recipients you explicitly authorise (e.g. integrations you connect to Slack, Google Calendar, GitHub) receive only the data required for the connection you configured.

We do not share your data for any other purpose.

6. Where it lives

Data is stored in the European Union. When a sub-processor operates outside the EU (for example, a US-headquartered AI provider), transfers are protected by the EU Standard Contractual Clauses and equivalent safeguards.

7. How long we keep it

- Account data: for as long as your account exists. When you delete your account (see section 9), your account data is deleted within 30 days.
- Workspace content: for as long as your workspace exists.
- Analytics data: 12 months from capture. After 12 months, PostHog aggregates it into anonymous cohorts.
- Push notification tokens: revoked immediately when you disable notifications on the device, or when your account is deleted.

Backups of the above are retained for 30 days from the moment the underlying data is deleted, then permanently removed.

8. Your choices

- Turn analytics off. The web app has a Privacy & data toggle in Settings that turns off PostHog capture for your account. The mobile app inherits this setting from your web-app account.
- Turn push notifications off. iOS Settings → Notifications → Maskin → Allow Notifications.
- Request a copy of your data. Email privacy@maskin.io.
- Correct or update your data. Sign in and edit it, or email privacy@maskin.io if you need help.
- Object to processing or restrict it. Email privacy@maskin.io.
- Withdraw consent to marketing (if you have given it — we currently send no marketing email). Email privacy@maskin.io.
- Lodge a complaint with a data protection authority. In the EU/EEA, your national DPA; in the UK, the ICO.

9. Delete your account

You can delete your account at any time from Settings → Account → Delete account, in either the web app or the mobile app. Deleting your account irreversibly removes your personal data within 30 days, subject to the backup retention in section 7. Workspaces you own with other members are transferred to the next-most-senior member; workspaces where you are the sole member are deleted with your account.

If the in-app flow is unavailable to you, email privacy@maskin.io and we will action the deletion within 30 days.

10. Children

The Service is not directed to children under 13, and we do not knowingly collect data from anyone under 13. If you believe we have, email privacy@maskin.io and we will delete the data.

11. Changes to this policy

We may update this policy from time to time. When we do, we update the "Last updated" date at the top and, for material changes, notify signed-in users inside the Service before the change takes effect.

12. Contact

Privacy questions: privacy@maskin.io
Data protection officer: dpo@maskin.io
Mailing address: <legal entity mailing address>
```

---

## Change control

- Update this file **whenever** anything in `app-privacy.md` changes.
- Update this file **whenever** a new sub-processor is added.
- After merging a change, re-publish the hosted copy at `https://maskin.io/privacy` on the same day and update the *Last updated* line.
- Cross-reference the App Privacy answers in App Store Connect on the next binary submission — stale answers ship to users the moment the next build lands.

---

## Placeholders to fill before publishing

- `<YYYY-MM-DD when the page goes live>` — set to the publication date.
- `<legal entity name and country of registration>` — the actual company details.
- `<legal entity mailing address>` — required for GDPR; a registered office address is fine.

---

## Related, non-blocking items

- **Sub-processor list.** The policy references a maintained sub-processor list. Publish one at `https://maskin.io/subprocessors` (or a section of the privacy page). Not required for App Store review, but a common enterprise-procurement ask post-launch.
- **Cookie / analytics banner.** If a cookie banner is added to maskin.io, keep the mobile app in sync: the *Privacy & data* toggle in Settings is the mobile equivalent, and the two must not disagree about whether analytics are on.
