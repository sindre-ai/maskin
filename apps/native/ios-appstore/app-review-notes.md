# App Review Notes

Copy-paste text for App Store Connect → *Apps → Maskin → \[version\] → App Review Information → Notes*, and for the *Sign-in Information* block on the same screen. This is what the human Apple reviewer sees before they touch the app — a reviewer who can't sign in, or is confused about what the app is for, rejects on Guideline 2.1 (App Completeness) without reading further.

Every `<...>` placeholder must be filled in before pasting.

---

## Sign-in Information

Tick *Sign-in required* on the App Review Information screen and paste:

- **Username:** `<demo-account-email>` — provision a dedicated account with a workspace that already has For You cards, bets, and tasks in it. Ordinary internal accounts churn membership; a stable demo account survives across submissions.
- **Password:** `not applicable — magic-link sign-in`
- **Notes:**
  ```
  Maskin uses passwordless magic-link sign-in. To sign in as the demo account:

  1. Launch the app.
  2. Enter the demo email address above on the sign-in screen.
  3. Tap "Send magic link".
  4. The reviewer inbox at <demo-inbox-url> receives the link within 30 seconds. Open the mailbox at that URL (public IMAP-less inbox, no login required), open the newest message from magic-link@maskin.io, and tap the "Open Maskin" button.
  5. iOS opens the Maskin app already signed in to the demo workspace. The demo workspace has pre-seeded For You cards, bets, and tasks so the reviewer can exercise every acceptance criterion without additional setup.

  If step 4's inbox is unreachable, contact <review-contact-email> and we will forward the link directly.
  ```

- `<demo-account-email>` and `<demo-inbox-url>`: provision a mailbox that Apple's reviewer can hit without a login. Suggested: `apple-review@maskin.io` with a public read-only web inbox at `mail.maskin.io/apple-review` (or the equivalent — the exact URL goes here). If a public inbox can't be provisioned in time, gate on it: the fallback in step 5 is the escape hatch, not the primary path — Apple frequently rejects submissions where sign-in requires an out-of-band handoff.

---

## Notes

Paste the block below into the *Notes* field verbatim. It answers the four questions reviewers actually have when opening a fresh app.

```
WHAT MASKIN IS
Maskin is a workspace where product teams review agent-generated "For You" cards and act on them. This iOS app is the mobile companion to the Maskin web app at maskin.io. Full authoring — creating bets, running agents, configuring integrations — lives on the desktop web app; this app is the read-and-act surface for the moments when a card needs a human call.

HOW TO EXERCISE THE APP
The demo account above signs the reviewer into a workspace pre-seeded with For You cards, bets, and tasks. Every acceptance criterion for this build can be verified from the demo workspace:
- Open the For You feed from the sidebar. Tap a card. Tap Approve, Dismiss, or Comment — each action completes and updates the card in the feed immediately.
- Open a bet from the sidebar. The bet detail scrolls readably on iPhone and uses the full width on iPad.
- Open the task list. Rows are legible; scrolling is smooth.
- To exercise push notifications: after signing in, keep the app installed but backgrounded. Reply to the confirmation email at review-contact@maskin.io with the text "trigger push" — we will fire a For You card from the demo workspace within one minute. iOS delivers the notification; tapping it opens directly onto the new card.

TECHNOLOGY NOTES FOR THE REVIEWER
- The app is built on Tauri 2 (webview-hosted native shell). This is not a repackaged website: it is a native binary that ships local code, uses native Keychain for API-key storage, native APNs for push notifications, and a native deep-link handler for the maskin:// scheme. See maskin.io/mobile for the technical details if the reviewer would like more context.
- The maskin:// URL scheme is registered for the magic-link sign-in flow only. It is not exposed for any other purpose and no other app is expected to launch Maskin.
- No third-party analytics or advertising SDKs. Full data-handling detail on maskin.io/privacy.

WHAT'S NEW IN THIS BUILD
First release. Every acceptance criterion is exercisable from the demo workspace as described above.

CONTACT DURING REVIEW
- Email: review-contact@maskin.io — monitored during business hours (CET), replies within 4 hours.
- Phone: <review-contact-phone> — same window.
- We will action any rejection reason on the same day; please reach us before rejecting for anything that reads like a setup issue.
```

- `<review-contact-phone>`: put the actual number the account holder will pick up. Don't leave the angle brackets in — App Store Connect surfaces this field verbatim.

---

## Contact Information (separate field on the same screen)

- **First name / Last name:** App Store Connect account holder (must match the Apple Developer team's registered contact).
- **Email address:** `review-contact@maskin.io` — a shared inbox that at least two humans watch during the review window. A single-person address is a rejection risk if that person is out.
- **Phone number:** same as `<review-contact-phone>` above.

---

## Attachment

None required. The app does not gate content behind a subscription, in-app purchase, or third-party account, so there is no supplemental documentation Apple would need to see.

---

## Optional but recommended

- Keep the demo account provisioned for at least six months post-approval; Apple runs post-approval spot-checks and will re-hit the same demo credentials on random future dates.
- If the demo account's password (magic-link email) rotates, update App Store Connect's *Sign-in Information* field the same day. Apple caches the credentials for their reviewer session; a stale one triggers a rejection with a "we could not sign in" note.
