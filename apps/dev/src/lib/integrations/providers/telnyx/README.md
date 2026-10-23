# Telnyx provider

## The voice assistant lives in code

The live Telnyx assistant (Rune, Danish) is built from **assistant.ts**: the Danish prompt, the opener, the workflow, the name, the model and the five webhook tools with their Authorization header and call id field. **ensureAssistant()** compares a content hash with the one stored in the assistant description and overwrites the live assistant when they differ.

**Change the assistant through a PR, never in the Telnyx portal.** A portal edit is overwritten by the next run (the nightly knowledge export, or a knowledge change).

- The hash is the **script_version** stamped on every consent record. It covers the prompt, tools and workflow, not the knowledge base tool. Tool headers count by name only, so rotating the secret keeps the version (and needs a manual update of the live assistant). **currentScriptVersion** throws when **MASKIN_PUBLIC_URL** is unset.
- The tool header is **Authorization: Bearer** plus **TELNYX_TOOL_WEBHOOK_SECRET**. If that variable is unset, the exporter does not create or update the assistant. Never log the payload: it carries the secret.
- The call id variable is **call_control_id**. Telnyx rejects dynamic variable names that start with **telnyx_**.
- The spoken first name is one constant, **ASSISTANT_FIRST_NAME**, used by both the opener and the prompt.
- **DISCLOSURE_PATTERNS** must match the opener. The post-call check flags a call as **disclosure_missing** otherwise.
- The test **assistant.test.ts** compares the payload with the fixture **fixtures/rune-live-assistant.json**, the snapshot of the live assistant taken on 2026-10-15.
