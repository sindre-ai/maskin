# Must-keep features (iPhone app)

Things a person does in the app that must keep working through every redesign. Each row has a UI
test in `Apps/MaskinUITests/MustKeepTests.swift` named `testMK<nn>_…`.

## Rules

1. **A redesign PR must not make any row fail.** Run the tests before opening the PR (command in the
   test file header). CI should run them too.
2. **Never delete or loosen a test to get a PR through.** If a feature is removed or moved on
   purpose, change its row here **and** its test in the same PR, and say so in the PR description
   ("Intentional change: MK-02 now starts from X").
3. **A bug that reached a user adds a row.** Fix it, add the row and test, so it cannot return.
4. Rows describe what the person does and sees, not how it looks. Looks belong to the snapshot tests.
5. Strict tests: an unreachable step is a failure, never a skip.

## The list

| ID | What the person does | What must happen | Test |
|----|----------------------|------------------|------|
| MK-01 | On For you, taps **Live briefing** in the top bar | The live call with the Chief of Staff opens (End call button visible) | `testMK01_LiveBriefingFromForYou` |
| MK-02 | In an agent chat, taps the **Live** button (chat header, or the composer waveform) | The live call with that agent opens | `testMK02_LiveWithAgentFromChat` |
| MK-03 | Long-presses a message and chooses **Reply in thread** | The thread opens with a Reply field | `testMK03_ReplyInThread` |

## Known differences between branches (decide before merging)

- `main`: Live in an agent chat is a **Live** button in the chat header; the composer waveform exists
  only in multi-person rooms.
- `native-v3-visual-check` (WIP port, not on main): the header button is gone and Live starts from the
  composer waveform in every chat. MK-02 accepts either; pick one on purpose.
- That branch also renames the For you / Items **Filter** button to **Display**.

## Candidates to add next

Send a message; edit and delete a message; react to a message; open the Threads list; pick a decision
option on a For you card; attach a file; mention someone with @; search; connect an integration;
sign in and sign out.
