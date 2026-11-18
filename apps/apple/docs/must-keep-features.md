# Must-keep features (iPhone app)

Things a person does in the app that must keep working through every redesign. Each row has a UI
test named `testMK<nn>_…` in `Apps/MaskinUITests/MustKeepTests.swift` (MK-01 to MK-09) or
`Apps/MaskinUITests/MustKeepMoreTests.swift` (MK-10 and up).

## What these tests prove, and what they do not

They prove that a button exists and that the call or thread screen opens, **on demo data**. They do
not prove that a call connects (no microphone, no voice backend), or that data the demo does not
contain renders. A row passing is necessary, not sufficient. Each row below states its own limit.

## Rules

1. **Run them before opening a design PR, and paste the result in the PR body.** The "Apple must-keep UI tests"
   workflow runs them on a hosted Mac when a PR changes the tests, the demo server or the script (it is not a
   required check, and takes 30 to 40 minutes). Run it by hand from the Actions tab when your PR touches none of
   those, or run `apps/apple/scripts/run-must-keep.sh` on a Mac (starts the demo server on a free port, runs the
   tests, stops it). They do not run nightly.
2. **A redesign PR must not make any row fail.**
3. **Never delete or loosen a test to get a PR through.** If a feature is removed or moved on
   purpose, change its row here **and** its test in the same PR, and say so in the PR description
   ("Intentional change: MK-02 now starts from X").
4. **Accessibility labels are the contract.** The tests find buttons by label. If you rename a
   button, keep its label or update the row and test in the same PR.
5. **A bug that reached a user adds a row.** Fix it, add the row and test, so it cannot return.
6. Rows describe what the person does and sees, not how it looks. Looks belong to the snapshot tests.
7. Strict tests: an unreachable step is a failure, never a skip.
8. **Every native fix that changes something a person taps adds or updates a row in the same PR**, with
   its test, and the PR body says the list was run by hand and what the result was (which rows passed,
   which failed). A fix with no row is how the same bug comes back.
9. **A row that fails when the list is run by hand becomes a task at once.** File one task per failed row
   without waiting for a person: `fix_class` small_fix, PR base main, driver Developer, linked back to
   the task that asked for the run, created at backlog and then moved to todo (the quick fix flow).
10. Data a row needs lives in `scripts/demo-server/fixtures.mjs` and must have the shape the real API
   sends (`null`, not placeholders such as `0` for "no thread").

## The list

| ID | What the person does | What must happen | Limit: what it does not prove | Test |
|----|----------------------|------------------|-------------------------------|------|
| MK-01 | On For you, taps **Live briefing** in the top bar | The call screen opens (End call and Minimise call buttons) | The call connects (in the demo it always reads "Couldn't connect the call"), audio works, which agent it is with | `testMK01_LiveBriefingFromForYou` |
| MK-02a | In the Chief of Staff chat, taps **Live** (chat header or composer waveform) | The call screen opens | Which agent the call is with; that it connects | `testMK02a_LiveWithChiefOfStaffFromChat` |
| MK-02b | In the Outreach room (several agents), taps **Live** | The call screen opens | Same | `testMK02b_LiveWithAgentRoomFromChat` |
| MK-03 | Taps the **More** button on a message and chooses **Reply in thread** | The thread opens with a Reply field | That a reply is sent | `testMK03_ReplyInThread` |
| MK-04 | In a chat, sees a message with replies | Shows "2 replies", replies stay out of the main timeline, tapping opens both replies | Unread counts, replies by agents, "also send to chat" | `testMK04_ThreadWithRepliesOpens` |
| MK-05 | In a chat, opens a long email draft card, then scrolls up and taps **Jump to latest** | The card opens and shows Approve (the screen stays responsive); the jump button shows and brings the end back | Editing the draft text, approving it, a draft that is already sent | `testMK05_LongDraftCardOpensInChat` |
| MK-06 | Opens Search from the profile sheet, types a chat's name, and long-presses the chat in the results | The chat's menu shows (Pin to top, Archive, Delete), the same as in the Chats list | Using any menu action; the menu for an item result; that search finds anything the demo does not contain | `testMK06_SearchResultLongPressMenu` |
| MK-07a | With a picture on the clipboard, long-presses the message field in a chat | The field's menu offers Paste | That pasting adds the picture as a chip (the paste itself is not tapped) | `testMK07a_FieldMenuOffersPasteForImage` Known failing (run 9): the field's menu showed only AutoFill with a picture on the clipboard; test or app not told apart. Task: https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/bdf11d71-f0e7-4967-b8f1-aeee63031435 |
| MK-07b | With a picture on the clipboard, taps the **+** (Attach) button in a chat | The menu lists **Paste image** | That the picture is attached | `testMK07b_AttachMenuOffersPasteImage` |
| MK-08 | In the Webinars chat, types a line and taps **Send** | The line shows in the chat | That the real server accepts it (the demo server echoes it); sending with attachments, mentions or a quote | `testMK08_TypeAndSendShowsMessage` |
| MK-09 | In the Webinars chat, pastes 8,200 characters and taps **Send** | The composer says the message goes as a file, and the chat shows the short message "…is attached as message-….txt" | That the file's content is right, or opens; a message just under 8,000 characters. The text is pasted, not typed | `testMK09_LongMessageSendsAsFile` |
| MK-10 | In the Contoso renewal chat, opens the thread under a message with two replies, the first from the Chief of Staff | The thread shows the agent's reply and the person's reply | Unread counts; that an agent writes a reply (the words are demo data); replying to the agent | `testMK10_AgentReplyInThreadIsReachable` |
| MK-11 | In Chats, taps **Threads**, then a thread in the list | The Threads list names the chat and the newest reply; the thread opens with the agent's reply | The New and Earlier split (the demo has one read thread); that the list refreshes when a reply arrives | `testMK11_ThreadsListOpensThread` |
| MK-12 | On For you, taps the recommended option of the first decision card (Send all 7) | The card leaves the open list, the choice shows as a receipt or toast, and Undo is offered | That the choice reaches the server or an agent (the demo records a comment), that Undo works, the confirm step for a destructive option | `testMK12_PickDecisionOptionOnForYou` |
| MK-13 | In the Priya Rao chat, types **@Pri** and picks Priya Rao | The list shows Priya Rao, and the pick becomes a chip in the composer | That the message is sent with the mention (nothing is sent); that an agent wakes up on it | `testMK13_MentionSomeoneInComposer` |
| MK-14 | In the profile sheet, taps **Sign out**, confirms, then signs in again with an email and password | The sign-in screen shows after signing out; signing in opens the app on For you | That the password is checked (the demo accepts any), sign-in with Apple or a code, the discarded queue | `testMK14_SignOutAndSignIn` Known failing (run 9), test side: the log shows the password was never typed (the loop that types it was skipped because Sign in read as enabled), so Sign in was tapped with an empty form and the sign-in screen stayed. Not seen as an app problem. |
| MK-15a | On their newest message, taps More, then **Edit**, adds words and taps Send | The composer says "Editing message"; the chat shows the edited words | That an older message can be edited (it cannot); the "edited" mark | `testMK15a_EditOwnNewestMessage` |
| MK-15b | On a message, taps More, then **React**, then 👍 | The message shows a 👍 chip with a count of 1 | Taking a reaction back; reactions by other people | `testMK15b_ReactToMessage` Known failing (run 9): the emoji menu closed after the tap but no 👍 chip showed under any message. Test or demo server or app not told apart (the test may also have opened More on the newest message, not the 12-month one). |
| MK-15c | Sends a message the server refuses | The chat shows "Not sent", and its More menu offers **Delete**, which removes it | Deleting a message that was sent: the app has no such action. Retry is not tapped | `testMK15c_DeleteUnsentMessage` |
| MK-16 | In the Priya Rao chat, taps **+** (Attach), then **File** | The system file picker opens | Choosing a file and attaching it (the picker is a system screen); photos and the camera. A long message going as a file is MK-09 | `testMK16_AttachMenuOpensFilePicker` |
| MK-17 | In Settings, opens **Integrations**, then Discover, taps PostHog, pastes a key and taps **Connect** | PostHog is in the Connected list | The sign-in sheet of an OAuth provider (Slack, Linear, Google): it opens a system sheet the demo cannot finish; that the key is valid | `testMK17_ConnectIntegrationWithKey` Known failing (run 9): Settings stays open with the Integrations row highlighted after three taps; test or app not told apart. Task: https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d19ad83d-c639-4cb3-b394-ec1f38f87095 |

## Candidates to add next

Use a row action from the Chats list (pin, archive, delete a chat).
