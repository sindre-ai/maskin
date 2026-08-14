# TestFlight test information

Copy-paste text for App Store Connect → *TestFlight → iOS → [build] → Test Information*. Apple caches these fields across builds for the same marketing version, so this is a one-time step per bump of `version` in `apps/native/src-tauri/tauri.conf.json`.

---

## Beta App Description

Maskin is a workspace where product teams review agent-generated *For You* cards and act on them from anywhere. This iOS build lets internal reviewers exercise the mobile card feed, bet/task overview surfaces, and push-notification delivery on a real device before an App Store submission.

## Feedback Email

mobile-feedback@maskin.io <!-- replace with the actual inbox that is monitored during the review window -->

## Marketing URL

https://maskin.io

## Privacy Policy URL

https://maskin.io/privacy <!-- replace with the actual privacy policy URL Apple review will hit -->

## What to Test

Run through each item on a physical iPhone (and iPad where noted). Report failures via the feedback email above or the bet's comments — link at the bottom.

- Sign in with a magic link. Open the link on the phone (`maskin://auth#key=...`) and confirm the app opens straight into the authenticated workspace without pasting a key.
- **For You card feed (iPhone)**: the feed loads, cards render without horizontal overflow, and the three actions — approve, dismiss, comment — each complete and update the feed immediately.
- **For You card feed (iPad)**: the feed uses the full width. It does not appear as an iPhone-sized column with empty gutters.
- **Bet and task overview**: bet list and bet detail are readable on iPhone without horizontal scroll; task list scrolls smoothly and each row is legible. Both surfaces render acceptably on iPad.
- **Push notification on delivery**: with the app closed, trigger a new For You card from another device. Confirm a system notification is delivered and the badge/count is correct.
- **Push notification deep link (foreground, background, cold start)**: tap the notification from each app state and confirm it opens directly on the correct card in the feed. A cold start (app not previously running) should also land on the correct card.
- **General polish**: confirm the app icon appears on the home screen after install, and the header/sidebar chrome does not overlap the status bar or home indicator on notched devices.

## Login Information for App Review

<!-- Only fill this in when submitting the build to Apple review, not for internal testers.
     Apple's reviewer will need a demo account they can sign in with. -->

- **Sign-in mode:** magic link (email-based).
- **Demo email:** apple-review@maskin.io <!-- provision a scoped review account before submission -->
- **Notes:** Sign in flow: enter the demo email → we send a link → tap the link in the iOS Mail app → app opens signed in.

## Contact Information

- First name / Last name — App Store Connect account holder.
- Email — same, or a shared release inbox that Apple will reach on rejection.
- Phone — same.

## Notes

- Every item above maps to a Done-When line on the bet [Maskin mobile app — ship iOS and iPad to the App Store](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/4ca116db-e335-465c-bb2b-40fbc401a6fa).
- The full reviewer sign-off list — the artifact a reviewer produces — lives in [`review-checklist.md`](./review-checklist.md).
