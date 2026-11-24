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
7. Live voice call with the screen locked: the steps in section 1b, shown on the device.
Account creation and deletion are not in this build: sign-up is hidden (see section 3).

## 1b. Background audio (guideline 2.5.4): start a live voice call and lock the screen
The app declares UIBackgroundModes: audio for one feature only, the live voice call with an agent. The call keeps the microphone and the agent's voice running after the screen is locked. Steps for the reviewer, on a physical iPhone (the call needs a microphone):
1. Open the app and sign in with the demo account (section 3).
2. On the For You tab, tap the Live briefing button in the top bar. This starts a live voice call with the Chief of Staff agent. (Alternative: Chats tab → open the Chief of Staff chat → tap Live in the chat header, or the waveform button "Start a live conversation" next to the message field.)
3. If iOS asks, tap Allow for Microphone. The call screen opens with the End call and Minimise call buttons.
4. Wait until the status line says the agent is listening, then say something short, for example "Give me a short briefing". The agent answers by voice.
5. While the agent is speaking, press the side button to lock the iPhone.
6. The call keeps running with the screen locked: the agent's voice continues and the microphone stays on (the status bar shows the orange microphone indicator). The Lock Screen shows a Live Activity card for the call with Mute and End buttons. You can speak again and the agent answers, still locked.
7. Unlock the iPhone. The call is still connected. Tap End call (or End on the Lock Screen card) to finish. Audio stops and the app plays no audio in the background after the call ends.

Notes for the reviewer:
- The call is a live conversation with an agent over the network, so the iPhone needs an internet connection.
- The demo account has the Chief of Staff agent, so step 2 works without any setup. No other feature in the app plays or records audio in the background.
- If the call cannot connect, the status line reads "Couldn't connect the call". Check the connection and the microphone permission (Settings → Maskin → Microphone) and start the call again.

## 2. Purpose and audience
Maskin is a shared workspace where small teams and their AI agents work together. People set direction (insights, bets, tasks); agents do the work and ask for decisions. The iOS app is the companion for people who already have a Maskin workspace: review what needs a decision, chat with teammates and agents, follow agent runs, and share links into the workspace. Audience: teams (and solo founders) running work with AI agents. Not for children; 16+.

## 3. Access
- Demo account: **&lt;EMAIL&gt; / &lt;PASSWORD&gt;** (to be provided; has a workspace with sample bets, tasks, two agents and a conversation).
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
- **Permissions:** microphone and speech recognition (dictation and the live voice call), photo library via the system picker, and add-only access when saving a received picture or video to Photos, notifications.
- **Background audio (`UIBackgroundModes: audio`):** used only while the person is on a live voice call with an agent, so the call keeps its microphone and the agent's voice running when the screen is locked or the app is in the background; the Lock Screen / Dynamic Island card shows the call with Mute and End buttons, and the app does not play audio in the background at any other time. Exact steps to see it: section 1b.
