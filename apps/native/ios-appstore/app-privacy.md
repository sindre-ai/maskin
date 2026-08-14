# App Privacy answers

Copy-paste answers for App Store Connect → *Apps → Maskin → App Privacy*. Apple asks you to declare every category of data the app or its embedded SDKs collect, whether each category is linked to the user's identity, and whether any is used to track them across other companies' apps or websites.

Every answer below is grounded in the current codebase — grep the referenced paths before submitting to confirm nothing has drifted.

---

## Do you or your third-party partners collect data from this app?

**Yes.**

Even though the app has no tracking SDKs, the sign-in email leaves the device (Contact Info), the workspace content the user reads or creates leaves the device (User Content), and PostHog captures page views (Usage Data). Answering *No* here is factually wrong and blocks submission at the App Privacy review step.

---

## Data Types

For each category, answer the sub-questions in the order App Store Connect asks them.

### Contact Info → Email Address

- **Collected?** Yes.
- **Linked to the user's identity?** Yes.
- **Used for tracking?** No.
- **Purposes:**
  - *App Functionality* — magic-link sign-in (`apps/native/README.md` describes the `maskin://auth#key=...` flow; the backend delivers the link to the email address the user enters).
  - *Product Personalization* — the email addresses the user's own workspace membership.

### User Content → Other User Content

- **Collected?** Yes.
- **Linked to the user's identity?** Yes.
- **Used for tracking?** No.
- **Purposes:**
  - *App Functionality* — bets, tasks, cards, comments, and any other object the user creates or acts on in the workspace. All of it lives in the user's Maskin workspace on the Maskin backend.

Do **not** tick *Photos or Videos*, *Audio Data*, *Gameplay Content*, *Customer Support*, *Health*, or *Sensitive Info*: the app collects none of these. There is no in-app upload of media, no support chat inside the app, no health data.

### Identifiers → User ID

- **Collected?** Yes.
- **Linked to the user's identity?** Yes.
- **Used for tracking?** No.
- **Purposes:**
  - *App Functionality* — the workspace and actor UUIDs are what every API call is scoped to. Registered as PostHog super properties (`workspace_id`, `actor_id`, `actor_type`) via `apps/web/src/lib/posthog.ts` so analytics can join by workspace.
  - *Analytics* — same properties are what powers per-workspace usage reporting.

Do **not** tick *Device ID*: the APNs device token is used only to deliver push notifications and is not shared with third parties.

### Usage Data → Product Interaction

- **Collected?** Yes.
- **Linked to the user's identity?** Yes.
- **Used for tracking?** No.
- **Purposes:**
  - *Analytics* — PostHog captures page views (`capture_pageview: true` in `apps/web/src/lib/posthog.ts`) and named product events. `person_profiles: 'identified_only'` and `autocapture: false` — Maskin explicitly opts out of PostHog's fingerprinting profile and the wildcard `autocapture` firehose.

### Diagnostics → Crash Data / Performance Data / Other Diagnostic Data

- **Collected?** No.
- The app does not embed a crash reporter, an APM SDK, or any other diagnostic collector. Apple's own StoreKit / TestFlight diagnostics are handled by iOS itself, outside the app's App Privacy scope.

### Everything else

Answer **No — Data is not collected** for every remaining category:

- Financial Info, Location, Sensitive Info, Contacts, Browsing History, Search History, Purchases, Other Data.
- Photos/Videos, Audio Data, Gameplay Content, Customer Support, Health, Fitness.

---

## Tracking

**Data Not Used to Track You.**

- No app-side tracking SDKs (no Meta, TikTok, Snap, Adjust, AppsFlyer, Branch, Segment, Amplitude session-replay, etc.).
- PostHog is used strictly for first-party product analytics inside the user's own workspace — same account, same first-party context. Apple's definition of *tracking* is linking data collected from this app to data collected from third-party apps or websites for advertising or brokerage. That is not what happens.
- No third-party ad SDKs. No IDFA request — the app must not display the App Tracking Transparency prompt, and `NSUserTrackingUsageDescription` is not in the Info.plist. If a future PR adds it, the App Privacy answer flips and both must move together.

## Privacy Manifest (PrivacyInfo.xcprivacy)

Apple requires a `PrivacyInfo.xcprivacy` file inside the app bundle *when* the app or any bundled SDK uses one of Apple's *required reason APIs* (file timestamp, system boot time, disk space, `UserDefaults`, active keyboards). The Tauri iOS shell itself doesn't touch these APIs directly; verify at submission time by running `xcrun --sdk iphoneos --show-sdk-path` and grepping the built `.ipa`'s embedded manifests. If any bundled SDK adds a manifest of its own, Xcode surfaces it in the archive validator — address there, don't guess in advance.

---

## Data Retention and Deletion

Apple no longer asks these questions on the App Privacy screen, but reviewers will still check that the app supports account deletion per Guideline 5.1.1(v).

- Account deletion: available from the workspace's *Settings → Account* screen on the mobile app (surfaces the same web route the desktop uses). This must work end to end before submission — see the pre-submission checklist. If it does not, submit with an *Alternative account deletion method* URL (`mailto:privacy@maskin.io`) filled in on the same App Store Connect screen, but that is a fallback, not a permanent answer.

---

## Change control

Any PR that:

- Adds a third-party SDK, OR
- Adds a new field to the sign-up / sign-in flow, OR
- Adds a new user-generated content type, OR
- Enables `autocapture: true` on PostHog, OR
- Adds the App Tracking Transparency prompt

…must update this file **and** re-submit the App Privacy questionnaire in App Store Connect before the next binary upload. Apple's App Privacy answers travel with the app record, not the binary, so a stale answer is served to users the moment the next build ships.
