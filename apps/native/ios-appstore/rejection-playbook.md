# Rejection playbook

If Apple rejects, don't debate the guideline in the reviewer thread first — fix it, resubmit, and re-open the dialog only if the fix triggers a second rejection under the same clause. Most rejections are boilerplate and clear on resubmit within one review cycle.

The playbook below covers the eight rejection categories most likely to bite a Tauri / webview app on first submission, in rough order of frequency. Each entry links to the concrete fix in the rest of this directory.

If the reason Apple cites doesn't map to any entry here, escalate on the bet — an unfamiliar rejection reason is a signal that the App Store review policy has moved and the wider docs need an update.

---

## 1. Guideline 4.2 — Minimum Functionality

**What it looks like:** *"Your app duplicates the content and functionality of an existing website, without offering enough native functionality to justify a place on the App Store."* — the exact wording Apple uses when a webview app fails the 4.2 bar.

**Why a Tauri app is exposed:** the entire UI is served from a webview. Apple's reviewers pattern-match hard on this: if the app *looks* like a wrapper, they file 4.2 without going further.

**The fix:** point Apple explicitly at the native surface area the app already has. Update `app-review-notes.md → Notes → Technology notes for the reviewer` to enumerate:

- Native Keychain integration for API-key storage (`apps/native/src-tauri/` — see the `keyring` crate wiring).
- Native APNs push-notification handler with a `maskin://` deep-link dispatcher (task T1's `tauri-plugin-push-notifications` wiring).
- Native deep-link handler for `maskin://auth#…` magic-link sign-in (task 1 predecessor commits).
- Native safe-area / notch handling in the shell (`fix(ios-shell): respect safe-area insets around header/sidebar chrome`).
- Native background→foreground SSE resume with `Last-Event-ID` (`feat(ios): resume the SSE stream with Last-Event-ID on background→foreground`).

Reply in Resolution Center with a one-paragraph summary of those points and resubmit. On the second review most 4.2 rejections clear.

**If Apple rejects again on the same clause:** the surface really is too thin. Escalate to the bet — this becomes an exit-condition candidate ("Apple rejects with no clear fix path") and the answer is not another cosmetic response, it's a native-feature bet on top of the shell.

---

## 2. Guideline 5.1.1(i) — Privacy - Data Collection and Storage

**What it looks like:** *"Your Privacy Policy URL is not accessible / does not describe how you collect, use, and store user data."*

**The fix:** verify `https://maskin.io/privacy` returns 200 in a private-window browser, and that the copy matches the Data Types answered on the App Privacy screen. If the URL was 200 at submit but 404 by the time Apple hit it, the site went stale — most likely a stale routing rule or a redirect gone wrong.

The definitive draft copy is in `privacy-policy-draft.md`. If the hosted policy is out of date, ship the draft copy first and reply *"Privacy Policy at https://maskin.io/privacy has been updated to accurately describe our data handling. Please review at your convenience"* and resubmit.

**Don't** attach the policy in Resolution Center as a PDF — Apple requires a public URL and will re-reject with the same clause.

---

## 3. Guideline 5.1.1(v) — Account Sign-In and Deletion

**What it looks like:** *"Your app supports account creation but does not include a mechanism for users to initiate account deletion."*

**The fix:** verify the *Settings → Account → Delete account* flow works end-to-end from the mobile app (the pre-submission checklist gate 4 covers this — if this rejection lands, the checklist wasn't walked).

If the flow doesn't work: ship it. This is a hard requirement — no in-app deletion, no App Store.

If a fix can't ship in the review window: fill in App Store Connect's *Account deletion URL* field (`Apps → Maskin → App Information → Account Deletion`) with the direct deletion URL (`https://maskin.io/settings/account/delete` or `mailto:privacy@maskin.io` as a fallback). Reply in Resolution Center with the URL. Reviewer accepts the mailto but treats it as a lesser answer — plan the in-app fix for the next release.

---

## 4. Guideline 2.1 — Information Needed / App Completeness

**What it looks like:** *"We were unable to sign in using the credentials provided"* or *"the app opens to a blank screen"* — Apple's generic bucket for "we couldn't exercise the app."

**The fix path (do all three):**

1. Rehearse the demo-account sign-in on the exact App Store build (not TestFlight) from a device on a different network than the office. If the magic-link email lands in spam on gmail.com, that's the issue — set up SPF / DKIM / DMARC on `magic-link@maskin.io` if not already.
2. Confirm `<demo-account-email>` still exists and has the demo workspace membership. Membership sometimes gets pruned by ordinary workspace clean-up jobs — re-invite if so.
3. Verify the demo workspace has ≥3 unresolved For You cards. An empty workspace looks broken to a reviewer.

Reply in Resolution Center with a step-by-step (numbered) walk-through of the successful sign-in from a fresh device, resubmit. Apple almost always clears on the next cycle.

---

## 5. Guideline 2.3.10 — Accurate Metadata / Screenshots

**What it looks like:** *"Your app's screenshots do not sufficiently reflect the app in use"* or *"the promotional text describes features that are not part of your app."*

**The fix:** re-capture screenshots against the exact build under submission, per `screenshots-spec.md`. Every removed feature, changed copy, or stale iconography is a violation. On the marketing side, walk `listing-metadata.md → Description` and `→ Promotional Text` and delete any sentence that references a feature the current build doesn't expose (e.g., "create bets from mobile" — this app is read-and-act only).

Re-upload the corrected screenshots + copy, resubmit.

---

## 6. Guideline 2.5.1 — Non-public API Usage

**What it looks like:** *"Your app uses or references the following non-public APIs, which is not permitted on the App Store: `SPI_XXXX`, `_privateMethod`."* — Apple lists the specific symbol.

**Why a Tauri app might trip this:** transitively via a Rust crate or an Objective-C bridge. Native Tauri code doesn't call SPI directly, but a dependency (a WebKit bridge, a keyring backend, a push-notification bridge) can.

**The fix:**

1. Identify the flagged symbol from the rejection email.
2. `git grep -rn "<symbol>"` inside `apps/native/` and the `Cargo.lock` graph. Most matches are in a single crate.
3. Check the crate's issue tracker for the same rejection — usually there's an already-shipped fix on a newer version.
4. Bump the crate, rebuild, resubmit.

If the flagged symbol is legitimately used by a dependency the app cannot drop, escalate to the bet — this is an exit-condition candidate.

---

## 7. Guideline 2.1 — Crashes on launch / during review

**What it looks like:** *"Your app crashed on iPhone 15 Pro Max running iOS 18.4"* with a crash log attached.

**The fix:**

1. Symbolicate the attached `.crash` log against the archive in App Store Connect's *TestFlight → Archives*. Xcode → *Window → Organizer → Crashes* auto-symbolicates recent uploads.
2. Cross-reference against the internal-review sign-off — if the reviewer's device / iOS combination matches, the crash was missed; if not, it's a device we don't have on hand.
3. Ship the fix on a new build. Bump `apps/native/src-tauri/tauri.conf.json`'s `version` if the fix is user-visible; otherwise the same marketing version with a new build number is fine.

Never mark the crash "not reproducible" in Resolution Center without a fix — Apple stops responding.

---

## 8. Metadata rejection — missing / mismatched required field

**What it looks like:** *"Your app's Age Rating is inconsistent with the content described"* or *"Support URL is unreachable"* — small-print field errors.

**The fix:** re-walk `listing-metadata.md` for every field, check every URL in a private-window browser. Fill in any field that was left blank, correct any URL that 404s or redirects to a login page. Resubmit — metadata rejections are cheap and clear immediately.

---

## Response cadence

- **First rejection:** fix + resubmit, brief Resolution Center reply pointing at the fix. Don't argue the guideline.
- **Second rejection under the same clause after a genuine fix attempt:** open a written appeal via App Review Board, cite the specific evidence (paths, commit SHAs, screenshots). Copy Magnus + the bet's Ship Notes.
- **Third rejection under the same clause:** the bet's exit condition fires. This is genuine "no clear fix path" territory — hand back to the strategist.

---

## When to escalate immediately

If any of the following show up in the reason, don't try the playbook — escalate on the bet the same session, before resubmitting:

- **Section 3.2.2 (Unacceptable Business Model)** — a policy shift in how App Store treats agent-driven products. Rare; not something a resubmit will clear.
- **Rejection with no cited guideline** — happens occasionally when a reviewer uses a template incorrectly. Ask for the specific clause in Resolution Center before making any change.
- **Threat of app removal from an already-approved release** — this is post-approval and outside T7's scope; escalate to the account holder immediately.
