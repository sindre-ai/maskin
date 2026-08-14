# App Store listing metadata

Copy-paste text for App Store Connect → *Apps → Maskin → iOS App → \[version\] → App Information* and *[version] → iOS App Preview and Screenshots*. Apple splits fields between "App Information" (edited once per app, applies to every version) and "Version Information" (edited per version). Both are covered here — the section headings match what App Store Connect calls each field.

Every placeholder is wrapped in `<...>` — search the file for `<` before you paste.

---

## App Information (once per app)

### Name
`Maskin`

- Max 30 characters. `Maskin` is 6 — fits in every locale.

### Subtitle
`Steer your AI agents from anywhere`

- Max 30 characters (currently 30 — count it before editing).
- Shown under the app name on the App Store product page.

### Bundle ID
`io.maskin.mobile` — must already match the app record created in step 2 of `../ios-testflight/README.md`.

### SKU
`io.maskin.mobile` — any stable identifier; matches Bundle ID for symmetry.

### Primary Language
`English (U.S.)`

### Category
- **Primary:** *Productivity*
- **Secondary:** *Business*

### Content Rights
Answer *No* to *Does your app contain, show, or access third-party content?* — the workspace surfaces user- and agent-generated content within the same Maskin account, not third-party content in the App Store sense.

### Age Rating
Walk App Store Connect's questionnaire and answer every category *None*. Expected outcome: **4+**. If the reviewer marks it higher, the likely trigger is *Unrestricted Web Access* — for the Maskin shell it is bounded to the Maskin webview (no in-app browser to arbitrary URLs), so answer *No* there too.

### Privacy Policy URL
`https://maskin.io/privacy`

- ⚠️ **This URL does not exist yet on maskin.io.** See `privacy-policy-draft.md` for the copy that needs to go live. Hosting the page is a blocking gate on the pre-submission checklist.

### Support URL
`https://maskin.io/support`

- If a dedicated support page does not exist by submission time, `https://maskin.io` is an acceptable fallback (Apple only requires it resolve and describe how to contact you).

### Marketing URL
`https://maskin.io`

---

## Version Information (per version — first submission is `0.1.0`)

### What's New in This Version
```
First release of Maskin for iPhone and iPad.

Review and act on the For You card feed from anywhere. Approve, dismiss, or comment on cards directly from the phone. Bet and task overview surfaces come along for the ride, and push notifications tap through straight to the card that fired them.
```

- Max 4000 characters. Reuse this exact block for the initial submission; bump per subsequent release.
- Not required on the very first version submission, but Apple recommends including it.

### Promotional Text
```
Steer autonomous agents from your pocket. Review For You cards, act instantly, and never miss the signal that needs you.
```

- Max 170 characters (currently 152). Editable without a new binary submission — use it for time-boxed promos.

### Description
```
Maskin turns your product team into a bet-driven organisation where autonomous agents do the execution and humans steer. This app is the mobile companion to the Maskin workspace at maskin.io — built for the moments when a For You card lands and you need to act.

WHAT YOU CAN DO ON MOBILE
• Review the For You card feed the moment agents surface something that needs a human call
• Approve, dismiss, or comment on cards from your phone or iPad
• Scan bets and tasks in a form that reads and scrolls comfortably on both form factors
• Get a push notification when a new card is ready — tap through straight to the card

WHAT LIVES ON THE DESKTOP
Full authoring — creating bets, editing tasks, running agents, configuring integrations — is on the Maskin web app at maskin.io. The mobile app is the read-and-act surface, so the moment a card needs a human, you can close the loop without going back to the desk.

SIGN IN
Enter your work email, tap the magic-link email that arrives, and the app opens signed in. No password to remember and nothing to configure. You need an existing Maskin workspace — create one for free at maskin.io.

PRIVACY
The app talks only to Maskin's own backend and never to third-party trackers. See maskin.io/privacy for the full data-handling detail. You can delete your account from the account settings screen at any time.
```

- Max 4000 characters. Keep the section headings — App Store Connect renders line breaks but no other markdown.

### Keywords
```
agents,productivity,ai,workspace,bets,tasks,team,workflow,cards,pm
```

- Max 100 characters *total*, comma-separated (single line, no spaces around commas). Currently 60.
- Do not repeat *Maskin* or words already in the Name/Subtitle — Apple already indexes those.

### Copyright
`© 2026 Maskin` (or the legal entity name once decided — one line, max 100 characters).

### Trade Representative Contact Information
Not required for App Store distribution outside Korea. Skip unless targeting Korea explicitly.

### Version Number
`0.1.0` for the first submission. Must match `apps/native/src-tauri/tauri.conf.json`'s `version` field on the build being submitted.

### Build
Select the exact TestFlight build that internal review signed off on. Its number matches `GITHUB_RUN_NUMBER` from the workflow that produced it — cross-check against the bet's Ship Notes before pinning.

---

## App Store Screenshots and Preview

Handled separately — see `screenshots-spec.md` for required sizes, frames, overlay copy, and capture recipe. Screenshots upload on the same *App Store* → *iOS App* → *[version]* screen but under a different section.

---

## Pricing and Availability

- **Price:** Free
- **Availability:** *Available in all territories*
- **Volume Purchase Program:** *Not available for pre-order and no discount for educational institutions* — the app is free.

---

## Submission Information (only asked on the first submission)

- **Contact Information:** App Store Connect account holder name + email + phone. Apple emails this address on rejection.
- **Notes:** paste the `app-review-notes.md` body into the *Notes* field before submitting.
- **Demo Account:** the demo credentials block in `app-review-notes.md` also fills App Store Connect's *Sign-in Information* → check *Sign-in required* and paste there.
- **Attachment:** none. The app has no gated content beyond the sign-in.

---

## Localisation

First release ships English-only. Every field on the Product Page uses the *English (U.S.)* locale. Once translations exist, App Store Connect lets you add locales without re-submitting the binary — cover that in a follow-up bet.
