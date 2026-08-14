# Pre-submission checklist

The human with App Store Connect access walks this list once, in order, before clicking *Submit for Review*. Every line is a pass/fail, every fail has a concrete unblock. Paste the completed list into the T7 task's Ship Notes so the audit trail matches what was actually verified.

**Submitting version:** `<paste marketing version and build number, e.g. 0.1.0 (42)>`
**Submitter:** `<name>`
**Date:** `<YYYY-MM-DD>`

---

## Blocking gates

Every item below must be **PASS** before Submit for Review. Any FAIL blocks the submission — do not push through.

### 1. TestFlight build is internally approved

- [ ] The build under submission is the same one the internal reviewer signed off on via `../ios-testflight/review-checklist.md`.
- [ ] Reviewer name and build number are recorded in the bet's Ship Notes.

**If fail:** the build hasn't been reviewed yet — the DoD on T6 isn't closed. Loop back to T6 before continuing.

### 2. Privacy Policy is publicly hosted

- [ ] `https://maskin.io/privacy` returns HTTP 200 and renders a privacy policy in a browser (private/incognito, no cookies).
- [ ] The hosted copy matches (or is a superset of) `privacy-policy-draft.md`.
- [ ] The page is reachable from `https://maskin.io` via a visible link (Apple sometimes rejects a policy that only exists at the deep-linked URL).

**If fail:** publish the page first. This is the single most common cause of a P1 rejection. `privacy-policy-draft.md` is the copy — hosting it is on the humans.

### 3. Demo account works end-to-end

- [ ] `<demo-account-email>` receives a magic link within 30 seconds when a sign-in is requested from the App Store build.
- [ ] The link opens the app already signed in (no key paste).
- [ ] The demo workspace has ≥3 unresolved For You cards, ≥3 bets, ≥6 tasks.
- [ ] Push-notification delivery has been rehearsed in the last 24h against the demo account (see `app-review-notes.md` — the "trigger push" contact-email dance).

**If fail:** the reviewer will hit "we could not sign in / the app is empty" and reject on Guideline 2.1. Fix the demo account before Submit.

### 4. Account deletion works from within the app

- [ ] Signed in as a throwaway account, walking *Settings → Account → Delete account* completes end-to-end and the account no longer signs in afterwards.
- [ ] The flow is reachable from the mobile app (not desktop-only).

**If fail:** either fix the flow (preferred), or fill in App Store Connect's *Account deletion URL* field with `mailto:privacy@maskin.io` as an alternative. Reviewer accepts the mailto but treats it as a lesser answer.

### 5. Screenshots match the current build

- [ ] Five screenshots per size class (6.9", 6.5", 13"), matching `screenshots-spec.md`.
- [ ] Every frame reflects the *current* build's UI — no stale copy, no removed features, no old iconography.
- [ ] No status bar retouching, no marketing-style backgrounds, no third-party logos.

**If fail:** re-capture. Apple's Guideline 2.3.10 rejection ("screenshots inaccurate") is boilerplate and usually issued within an hour.

### 6. Age Rating is complete and matches the app

- [ ] App Store Connect's Age Rating questionnaire has been walked and every answer matches `listing-metadata.md → Age Rating`.
- [ ] Resulting rating is 4+.

**If fail:** re-walk the questionnaire. Do not accept a pre-populated answer.

### 7. App Privacy questionnaire matches `app-privacy.md`

- [ ] Every Data Type declared in `app-privacy.md` is answered *Yes* in App Store Connect.
- [ ] Every category not in `app-privacy.md` is answered *No*.
- [ ] *Data Not Used to Track You* is selected.

**If fail:** correct in App Store Connect. The App Privacy answers ship with the app record, not the binary — a stale answer stays visible to users on the product page even after the next build lands.

### 8. Sign-in Information and Notes are filled in

- [ ] *Sign-in required* is ticked on the App Review Information screen.
- [ ] Username / password / notes fields match `app-review-notes.md → Sign-in Information`.
- [ ] The *Notes* field contains the full block from `app-review-notes.md → Notes`.
- [ ] Contact email + phone are fresh — the addressee is available during the review window (Apple's window is 24–72 hours after submit).

**If fail:** paste the correct blocks. Contact channels that go stale during review are a leading rejection reason.

### 9. What's New, Description, Keywords, Categories are filled in

- [ ] Every field in `listing-metadata.md → Version Information` is pasted in App Store Connect.
- [ ] Support URL and Marketing URL both return HTTP 200 in an incognito browser.
- [ ] Primary category is *Productivity*, secondary is *Business*.

**If fail:** paste the missing field. Empty required fields block Submit at the App Store Connect UI level, but incorrect URLs make it through and trigger a Guideline 1.5 rejection.

### 10. Build metadata is clean

- [ ] `apps/native/src-tauri/tauri.conf.json`'s `version` matches the *Version Number* selected in App Store Connect.
- [ ] The selected build's number is monotonically greater than every prior build in this marketing version (App Store Connect enforces this — but confirm the selection is deliberate).
- [ ] `NSUserTrackingUsageDescription` is **not** present in the Info.plist (grep `apps/native/src-tauri/gen/apple/**/Info.plist` after `pnpm ios:init`). If it is, the ATT prompt is coming and the App Privacy answers must change.
- [ ] No leftover `com.apple.developer.aps-environment=development` in the entitlements — see `../ios-testflight/scripts/apply-gen-apple-tweaks.sh`, which pins this to `production` for App Store distribution.

**If fail:** rebuild after fixing. A mismatched version is the leading cause of a build simply not appearing in the "select build" dropdown.

---

## Non-blocking — nice to have

### 11. Marketing prep

- [ ] Support URL points to a page describing how to contact Maskin support (not just the marketing home). Falling back to `https://maskin.io` is acceptable; a dedicated page is better.
- [ ] The launch communication plan (blog post, tweet, in-app announcement) is ready to fire on approval — this can happen after Submit but before Apple's approval, so Approval → Ship is minutes not days.

### 12. Post-approval bookmarks

- [ ] The team has agreed who monitors App Store Connect for the *Waiting for Review* → *In Review* → *Approved / Rejected* state changes. Apple emails the account holder; if that mailbox isn't watched, the state change is missed.

---

## Once the list is clean

Click *Submit for Review* in App Store Connect. The submission moves to *Waiting for Review* within seconds. Apple's median first-response time in 2026 is 24–48 hours. Log the submit timestamp and the App Store Connect version-record URL in the T7 task's Ship Notes so the audit trail is closed.

If Apple rejects, walk `rejection-playbook.md` — every P1 rejection has a mapped fix path.
