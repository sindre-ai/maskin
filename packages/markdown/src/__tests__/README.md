# Round-trip fixture suite (`tiptap-markdown` de-risk)

This directory carries the CI safety net for the [Rich Markdown editor bet](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01). Every merge to `main` runs it via `pnpm test`; a regression fails the build.

## What it guards

The bet stores Markdown as the canonical string on every object body, comment, and knowledge doc. When the Tiptap editor mounts, `tiptap-markdown` parses that string into a ProseMirror doc; when the user blurs, it serializes back to Markdown and persists it. If a parse/serialize pair silently drops content on real agent-generated blobs, humans lose their data on the next save. This suite is the wall between that failure mode and production.

The load-bearing product assumption (tech spec §13): `tiptap-markdown` handles ≥95% of agent-generated blobs losslessly. If this suite ever fails on real content, escalate — see *When the suite breaks* below.

## The contract every fixture asserts

**Idempotence after one full round-trip:**

```
serialize(parse(serialize(parse(md)))) === serialize(parse(md))
```

The **first** `serialize(parse(md))` is allowed to normalize the input. `tiptap-markdown` will:

- Rewrite setext headings (`===`, `---` underlines) as ATX (`#`, `##`).
- Wrap bare autolinks in `<...>`.
- Renumber list markers to a canonical form.
- Drop raw HTML (`<div>`, `<!-- -->`) — this matches the existing sanitizer behavior in `packages/markdown/src/sanitize.ts`.

The **second** pass must match the first byte-for-byte. That's the actual guarantee: the doc has reached a fixed point. Anything else means the serializer is throwing information away.

## Adding a fixture

**Fixtures MUST be verbatim copy-pastes from live objects.** No synthesis, no hand-crafted "representative examples." The whole value of this suite is that it tests what agents actually emit, not what we imagine they might.

Sources allowed:
- Bet body (`content` field on a `bet` object)
- Task body (`content` field on a `task` object)
- Knowledge body (`content` field on a `knowledge` object)
- Insight body (`content` field on an `insight` object)
- Content body (`content` field on a `content` object)
- Comment body (`data.content` field on a comment event)
- File body when it's a checked-in Markdown attachment on a bet or knowledge object (e.g. a tech spec)

Steps:

1. **Find a real object.** Use the Maskin MCP tools (`list_objects`, `get_objects`, `get_comments`, `get_file`) or browse the workspace UI. Pick one whose content exercises Markdown feature(s) not yet covered by an existing fixture — see the *Coverage checklist* below.
2. **Copy the body verbatim** into a new `NN-{short-slug}.md` file in this directory. Do NOT edit whitespace, wrap lines, or "clean up" the content. Preserve the original bytes.
3. **Register it in `manifest.ts`.** Add a `FixtureProvenance` entry with the filename, `kind`, `sourceUrl` (the URL of the source object at the time of capture), and a short `label` for test output. The suite will fail with a helpful error if the fixture file exists but isn't registered — the missing-provenance check is what enforces the "no synthesis" rule.
4. **Run the suite locally:** `pnpm --filter @maskin/markdown test -- --run`. If the new fixture fails, see the next section.

## When the suite breaks

Two shapes:

**A new fixture fails on the first commit.** You just added a real blob and the round-trip drifted. This is the signal the bet exists to catch. Do NOT delete the fixture, and do NOT tune it to pass. Instead:

1. Note which block type(s) the fixture exercises. Cross-check against `block-types.test.ts` — is there a targeted unit test for that shape? If yes, does it also fail?
2. Count what fraction of registered fixtures now fail. **If more than 5% of the fixture set (currently ≥1 of ≥20) fails on real content, STOP** and escalate to Planner. The bet's load-bearing sizing assumption (tech spec §13: ≥95% lossless) is broken and the bet may need re-scoping (dropping the affected block types from v1). This is the signal Task 4 was written to surface.
3. If it's a single fixture with an unusual shape, file a comment on the [round-trip fixture task](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/641ca735-1725-46e6-b01c-939de1c1d447) linking the failing fixture and describing the drift — Planner decides whether it's serializer/parser work or an acceptable known-lossy edge case.

**An existing fixture starts failing after an unrelated change.** Someone bumped `tiptap-markdown`, updated an extension, or touched `packages/markdown/src/roundtrip.ts`. Either:
1. The upstream bump introduced a regression — pin back or file an upstream issue.
2. The extension config changed in a way that legitimately changes normalization — update the fixture assertion if (and only if) the new normalized form is still lossless. Never "just accept" the new output without verifying the underlying doc is unchanged.

## Coverage checklist

The fixture set must exercise every one of these (checked = covered by ≥1 registered fixture; the block-types unit test covers all of them individually as a floor):

- [x] ATX headings H1
- [x] ATX headings H2
- [x] ATX headings H3
- [x] Bold (`**...**`)
- [x] Italic (`*...*`)
- [x] Inline code (`` `...` ``)
- [x] External `https://...` links
- [x] Maskin object links (`/<ws>/objects/<id>`)
- [x] Unordered lists (flat)
- [x] Unordered lists (nested)
- [x] Ordered lists (flat)
- [x] Ordered lists (nested)
- [x] Horizontal rules (`---`)
- [x] Fenced code blocks with language (`` ```jsonc ``, `` ```ts ``)
- [x] Fenced ```chart blocks (Maskin custom for inline recharts)
- [x] GFM tables
- [x] Hard breaks (`  \n`)

Not yet covered by a real-content fixture — covered exclusively by `block-types.test.ts` because Maskin agents don't emit these shapes today. Add a real-content fixture the first time an agent emits one:

- [ ] ATX headings H4–H6
- [ ] Strikethrough (`~~...~~`)
- [ ] Blockquotes (`>`)
- [ ] Nested blockquote + fenced code block
- [ ] GFM task lists (`- [ ]` / `- [x]`)
- [ ] Escaped characters (`\*`, `\_`)

## Fork-fallback plan

`tiptap-markdown` is community-maintained (`aguingand/tiptap-markdown` on GitHub; last release Aug 2025 as of the bet spec date). Community-maintained is the load-bearing risk called out in the tech spec (§12 rabbit hole #4). If it is abandoned:

1. **Fork it into the repo.** Copy the `tiptap-markdown` source into `packages/markdown/src/serializer/` and maintain it in-tree. The MIT license permits this without upstream involvement. Preserve the original copyright header + a `FORKED_FROM.md` noting the commit SHA and reason.
2. **Add the new location to the import path in `packages/markdown/src/roundtrip.ts` and `packages/markdown/src/react/editor.tsx`.** Replace `import { Markdown } from 'tiptap-markdown'` with `import { Markdown } from '../serializer'`.
3. **Remove the `tiptap-markdown` package.json entry.** Add `markdown-it` directly to `dependencies` (tiptap-markdown's only non-Tiptap runtime dep).
4. **Run this fixture suite.** If everything passes on the forked copy, we own it. The suite is the gate.
5. **Cut a lightweight maintenance cadence** (quarterly triage) so the fork doesn't become a graveyard. Track upstream commits for security fixes; port them selectively.

The fixture suite is what makes this fork viable — without it, we'd have no way to trust a maintenance patch. With it, we have a red/green signal on every commit.

## Running the suite

```
pnpm --filter @maskin/markdown test -- --run
```

Under vitest with `environment: 'jsdom'` (configured in `packages/markdown/vitest.config.ts`) — tiptap-markdown constructs a real ProseMirror doc which needs a DOM.

The suite is picked up by the root `unit-tests` CI job (`.github/workflows/ci.yml`); no extra CI wiring needed. A regression fails the build the same way any other unit test regression does.
