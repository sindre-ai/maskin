# App Review notes (paste into App Store Connect → App Review Information → Notes, and reply to guideline 2.1 "Information Needed")

Apple sent Skjald this exact request on 2026-10-01 because the Mesh Firm ApS account has limited review history. Expect it for Maskin too. Everything below answers it up front.

## 1. Screen recording (physical device, latest OS) — TO RECORD, cannot be produced by an agent
Record on a real iPhone, starting at app launch:
1. Launch → sign in with the demo account.
2. For You feed → open a decision → approve/reject.
3. Chats → open a conversation → send a message, attach a photo, dictate a message.
4. Agents and Loops → open one.
5. Settings → Plan and usage (read-only) → sign out.
6. Share a link from Safari into Maskin (share extension).
Account creation and deletion are not in this build: sign-up is hidden (see section 3).

## 2. Purpose and audience
Maskin is a shared workspace where small teams and their AI agents work together. People set direction (insights, bets, tasks); agents do the work and ask for decisions. The iOS app is the companion for people who already have a Maskin workspace: review what needs a decision, chat with teammates and agents, follow agent runs, and share links into the workspace. Audience: teams (and solo founders) running work with AI agents. Not for children; 16+.

## 3. Access
- Demo account: **<EMAIL> / <PASSWORD>** (to be provided; has a workspace with sample bets, tasks, two agents and a conversation).
- The app signs in to an existing account. In-app account creation is intentionally hidden in this version, so no account-deletion flow is required.
- No sample files needed. Photos and files are attached from the system picker.

## 4. External services
- Maskin backend (https://maskin.io) — API, accounts, data.
- Anthropic Claude — runs the workspace's AI agents (server side; the app sends no model keys).
- Apple Push Notification service — notifications.
- Apple Speech framework — optional dictation in chat (on device where supported).
- Workspace integrations the owner connects on the website (Slack, GitHub, LinkedIn and others) — configured on the web, not inside the app.
- No ads, no tracking, no third-party analytics SDK in the app.

## 5. Regional differences
None. Features and content are the same in every region.

## 6. Regulated industry / third-party material
None.

## Other points reviewers ask about
- **Payments:** none in the app. Plan and credits are managed on the website; the app only shows read-only usage and has no purchase button or link to purchase.
- **User-generated content:** content is private to the members of a workspace (people invited by the owner) and their agents. No public feed, no anonymous or stranger-to-stranger content.
- **Permissions:** microphone and speech recognition (dictation only), photo library via the system picker, notifications.
