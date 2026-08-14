# Internal reviewer sign-off checklist

One internal reviewer walks this list on a physical iPhone (and iPad where noted) after installing the TestFlight build. Each line is a pass/fail. Paste the completed list back into the bet's comments — this is the audit artifact that closes the DoD line *"at least one internal reviewer has confirmed the build installs and core flows work"*.

**Build under review:** `<paste marketing version and build number from TestFlight, e.g. 0.1.0 (42)>`
**Reviewer:** `<name>`
**Devices:** `<iPhone model + iOS version> / <iPad model + iPadOS version if tested>`
**Date:** `<YYYY-MM-DD>`

---

## Install

- [ ] TestFlight shows the build under *Ready to Test*.
- [ ] Installing via the TestFlight iOS app completes without error.
- [ ] Launching the installed app opens directly to the Maskin sign-in surface (no white screen, no crash on boot).
- [ ] The Maskin app icon appears on the home screen (not the generic template icon).

## Sign in

- [ ] Requesting a magic link succeeds.
- [ ] Opening the `maskin://auth#…` link on the phone launches the app already authenticated (no need to paste the key).
- [ ] The header and sidebar chrome do not overlap the status bar or home indicator.

## For You card feed — iPhone

- [ ] The feed loads.
- [ ] Cards render without horizontal overflow.
- [ ] **Approve** completes and the card reflects the new state in the feed immediately.
- [ ] **Dismiss** completes and the card reflects the new state in the feed immediately.
- [ ] **Comment** completes and the new comment is visible on the card immediately.
- [ ] Tap targets are thumb-sized (no misfires).

## For You card feed — iPad

- [ ] The feed uses the full width — no iPhone-sized column with empty gutters.
- [ ] All three card actions work identically to iPhone.

## Bet and task overview

- [ ] Bet list is readable on iPhone without horizontal scroll.
- [ ] Bet detail is readable on iPhone.
- [ ] Task list scrolls smoothly on iPhone; each row is legible.
- [ ] Both surfaces render acceptably on iPad (no letterboxing).

## Push notifications

- [ ] Triggering a new For You card from another device delivers a system notification on the phone within a few seconds.
- [ ] Tapping the notification from the **foreground** (app already open) opens the correct card.
- [ ] Tapping the notification from **background** (app open, phone locked or on another app) opens the correct card.
- [ ] Tapping the notification from a **cold start** (app force-quit, no prior session) opens the correct card.

## Regression check

- [ ] Nothing on the desktop web app has visibly regressed as a side-effect of the mobile changes (spot-check the same account on desktop).

---

**Verdict:** ☐ approve for App Store submission &nbsp;&nbsp; ☐ block — see notes below

**Notes / defects:**

<!-- Free text. Reference bet, task, or PR ids where relevant. -->
