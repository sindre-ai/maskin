# Must-keep features (iPhone app)

Things a person does in the app that must keep working through every redesign. Each row has a UI
test in `Apps/MaskinUITests/MustKeepTests.swift` named `testMK<nn>_…`.

## What these tests prove, and what they do not

They prove that a button exists and that the call or thread screen opens, **on demo data**. They do
not prove that a call connects (no microphone, no voice backend), or that data the demo does not
contain renders. A row passing is necessary, not sufficient. Each row below states its own limit.

## Rules

1. **Run them by hand before opening a design PR, and paste the result in the PR body.** They do not run
   nightly and not on PRs; nobody runs them for you:
   `apps/apple/scripts/run-must-keep.sh` (starts the demo server on a free port, runs the tests,
   stops it). Until CI runs them, this is the only enforcement.
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
| MK-07a | With a picture on the clipboard, long-presses the message field in a chat | The field's menu offers Paste | That pasting adds the picture as a chip (the paste itself is not tapped) | `testMK07a_FieldMenuOffersPasteForImage` |
| MK-07b | With a picture on the clipboard, taps the **+** (Attach) button in a chat | The menu lists **Paste image** | That the picture is attached | `testMK07b_AttachMenuOffersPasteImage` |
| MK-08 | In the Webinars chat, types a line and taps **Send** | The line shows in the chat | That the real server accepts it (the demo server echoes it); sending with attachments, mentions or a quote | `testMK08_TypeAndSendShowsMessage` |
| MK-09 | In the Webinars chat, pastes 8,200 characters and taps **Send** | The composer says the message goes as a file, and the chat shows the short message "…is attached as message-….txt" | That the file's content is right, or opens; a message just under 8,000 characters. The text is pasted, not typed | `testMK09_LongMessageSendsAsFile` |

## Candidates to add next

In order: an agent's reply inside a thread is reachable; open the Threads list; pick a decision option
on a For you card; @mention someone; sign in and sign out; edit, delete and react to a message; attach a
file; use a row action from the Chats list; connect an integration.
