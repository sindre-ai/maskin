# Must-keep features (iPhone app)

Things a person does in the app that must keep working through every redesign. Each row has a UI
test in `Apps/MaskinUITests/MustKeepTests.swift` named `testMK<nn>_…`.

## What these tests prove, and what they do not

They prove that a button exists and that the call or thread screen opens, **on demo data**. They do
not prove that a call connects (no microphone, no voice backend), or that data the demo does not
contain renders. A row passing is necessary, not sufficient. Each row below states its own limit.

## Rules

1. **Run them before opening a design PR, and paste the result in the PR body:**
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
8. Data a row needs lives in `scripts/demo-server/fixtures.mjs` and must have the shape the real API
   sends (`null`, not placeholders such as `0` for "no thread").

## The list

| ID | What the person does | What must happen | Limit: what it does not prove | Test |
|----|----------------------|------------------|-------------------------------|------|
| MK-01 | On For you, taps **Live briefing** in the top bar | The call screen opens (End call and Minimise call buttons) | The call connects (in the demo it always reads "Couldn't connect the call"), audio works, which agent it is with | `testMK01_LiveBriefingFromForYou` |
| MK-02a | In the Chief of Staff chat, taps **Live** (chat header or composer waveform) | The call screen opens | Which agent the call is with; that it connects | `testMK02a_LiveWithChiefOfStaffFromChat` |
| MK-02b | In the Outreach room (several agents), taps **Live** | The call screen opens | Same | `testMK02b_LiveWithAgentRoomFromChat` |
| MK-03 | Long-presses a message and chooses **Reply in thread** | The thread opens with a Reply field | That a reply is sent | `testMK03_ReplyInThread` |
| MK-04 | In a chat, sees a message with replies | Shows "2 replies", replies stay out of the main timeline, tapping opens both replies | Unread counts, replies by agents, "also send to chat" | `testMK04_ThreadWithRepliesOpens` |

## Candidates to add next

In order: an agent's reply inside a thread is reachable; send a message and see it once; open the
Threads list; pick a decision option on a For you card; @mention someone; sign in and sign out; edit,
delete and react to a message; attach a file; search; connect an integration.
