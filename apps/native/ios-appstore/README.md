# App Store submission runbook

Operational rails for promoting an internally-approved TestFlight build to a full App Store submission, and reaching either *Approved* or *In Review* by the bet's exit date.

## What lives here

- `README.md` (this file) — end-to-end submission runbook.
- `listing-metadata.md` — every App Store Connect listing field, copy-paste ready.
- `app-privacy.md` — App Privacy questionnaire answers grounded in the current codebase.
- `app-review-notes.md` — Sign-in Information + Notes for the human Apple reviewer.
- `screenshots-spec.md` — required sizes, frames, overlay copy, capture recipe.
- `pre-submission-checklist.md` — pass/fail gate the human walks before clicking Submit.
- `rejection-playbook.md` — the eight most likely rejection reasons and the fix path for each.
- `privacy-policy-draft.md` — the copy that needs to go live at `https://maskin.io/privacy` before submission.

The TestFlight side of the release lives in `../ios-testflight/`; App Store submission builds on top of an internally-approved TestFlight build produced by that pipeline.

---

## Prerequisites

Everything in the TestFlight prerequisites in `../ios-testflight/README.md` must already be true — paid Apple Developer team, App Store Connect app record for `io.maskin.mobile`, distribution certificate, provisioning profile, App Store Connect API key.

Additionally:

1. **Tasks 1–5 and the TestFlight scaffolding are merged into `bet/maskin-mobile-app`.** Without them, there is no shippable app.
2. **A TestFlight build has been signed off** via `../ios-testflight/review-checklist.md` — reviewer name and build number recorded in the bet's Ship Notes.
3. **`https://maskin.io/privacy` returns HTTP 200** with the copy from `privacy-policy-draft.md`. Publishing the page is a human task; the copy is drafted here. Apple hard-blocks submission without a reachable Privacy Policy URL.
4. **A demo account is provisioned** (`<demo-account-email>` in `app-review-notes.md`) with a pre-seeded workspace containing ≥3 unresolved For You cards, ≥3 bets, and ≥6 tasks.

---

## The end-to-end flow

The human with App Store Connect access walks these seven steps once per submission. Steps 1–5 are App Store Connect data entry (paste from the files in this directory), step 6 is the pre-submission audit, step 7 is Submit.

### 1. Set App Information (one time per app)

App Store Connect → *Apps → Maskin → App Information*. Paste from `listing-metadata.md → App Information`:

- Subtitle, Category (primary + secondary), Content Rights, Age Rating.
- Privacy Policy URL, Support URL, Marketing URL.
- Account Deletion URL (if the in-app flow isn't ready — see pre-submission checklist gate 4).

Save. This applies to every future version of the app.

### 2. Fill the App Privacy questionnaire (one time, updated on data-collection changes)

App Store Connect → *Apps → Maskin → App Privacy*. Walk every category per `app-privacy.md`. Tick *Data Not Used to Track You*. Save.

If a subsequent PR changes what leaves the device (new SDK, new data type, ATT prompt), re-walk this screen before the next binary submission — App Privacy answers travel with the app record, not the binary.

### 3. Create the version and set Version Information

App Store Connect → *Apps → Maskin → \[+\] Version or Platform → iOS → New Version*.

- Version number: `0.1.0` for the first submission (must match `apps/native/src-tauri/tauri.conf.json`'s `version`).
- Paste from `listing-metadata.md → Version Information`:
  - What's New in This Version
  - Promotional Text
  - Description
  - Keywords
  - Copyright

### 4. Attach screenshots

App Store Connect → *Apps → Maskin → \[version\] → iOS App Preview and Screenshots*.

- Capture per `screenshots-spec.md` — five frames for each of 6.9" iPhone, 6.5" iPhone, 13" iPad.
- Upload in the order the spec prescribes (feed → card detail → push → bet → task list).

### 5. Select the build and fill App Review Information

App Store Connect → *Apps → Maskin → \[version\] → Build → Select a build from TestFlight*.

- Pick the internally-approved TestFlight build (build number is recorded in the bet's Ship Notes).
- App Review Information: tick *Sign-in required*, paste from `app-review-notes.md → Sign-in Information` and → *Notes*.
- Contact Information: paste from `app-review-notes.md → Contact Information`.

### 6. Walk `pre-submission-checklist.md`

Every gate in that file must be PASS. Any FAIL blocks Submit — fix, then walk the checklist again.

Paste the completed checklist into the T7 task's Ship Notes so the audit trail matches what was verified in App Store Connect.

### 7. Submit for Review

App Store Connect → *Submit for Review*.

- The submission moves to *Waiting for Review* within seconds. Apple's median first-response time in 2026 is 24–48 hours.
- Log the submit timestamp and the App Store Connect version-record URL in the T7 task's Ship Notes.
- Add the reviewer contact (`review-contact@maskin.io`) to the *Waiting for Review* watch — someone must be reachable during Apple's review window.

The T7 DoD closes when the state on the App Store Connect version record is either *Approved* or *In Review*, and that state was reached by the exit date (2026-09-26).

---

## If Apple rejects

Walk `rejection-playbook.md`. Every P1 rejection reason has a mapped fix path; most clear on resubmit within one review cycle. Don't argue the guideline in Resolution Center before shipping the fix — Apple stops responding.

The bet's exit condition ("If Apple rejects with no clear fix path, trigger the bet exit condition") fires only if the same clause is rejected three times after genuine fix attempts. Escalate on the bet before assuming the exit has fired.

---

## Post-approval

Once App Store Connect flips to *Ready for Sale*:

- The version becomes available on the App Store within four hours (Apple's own SLA — usually less).
- Fire the launch communication plan (blog post, tweet, in-app announcement).
- Record the App Store URL in the bet's Ship Notes.
- Start the T7 success-measurement window described in the bet: ≥25% of active workspace members take at least one For You card action via mobile within 4 weeks of launch.

Iterating on the App Store version afterwards (bug-fix releases, feature additions) reuses the same seven-step flow, minus step 1 — App Information is edited only when metadata changes.
