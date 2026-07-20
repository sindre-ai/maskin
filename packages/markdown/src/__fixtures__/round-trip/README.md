# GFM round-trip corpus

The `gfm-round-trip` CI job proves that Maskin's owned Markdown serializer (`packages/markdown/src/serialize.ts`) does not normalise untouched blocks: for every fixture in this directory, `serialize(parse(source)) === source` must hold byte-exact.

## Why this matters

Object content is stored as Markdown. Agents diff full strings. If the write path silently rewrites an unchanged block (`*` → `_`, indented → fenced, `  \n` → `\\\n`), every subsequent agent diff shows spurious churn and reviews become unreadable. This corpus is the CI gate that catches those regressions on every PR to `main` or `bet/tiptap-editor`.

## Adding a new fixture

1. Drop a `NN-short-name.md` file in this directory. Keep the numeric prefix contiguous so ordering stays stable.
2. Write the source in **canonical shape** (see below). The round-trip assertion is byte-exact, so the file *is* the expected serializer output.
3. Run `pnpm --filter=@maskin/markdown test:round-trip` locally. If it fails, either the fixture isn't in canonical shape or the serializer really does need adjusting — decide which.
4. Prefer sampling from real workspace objects (bet descriptions, comments, knowledge articles) when the shape is ambiguous. The corpus should look like what Maskin actually stores.

## Canonical shape (what the serializer emits)

Every option is set explicitly in `serialize.ts` — nothing relies on `remark-stringify` defaults. The canonical decisions:

| Construct        | Canonical form                                     |
| ---------------- | -------------------------------------------------- |
| Unordered list   | `-` at root, `*` for nested siblings               |
| Ordered list     | `1.`, incrementing per item                        |
| Emphasis         | `*italic*`                                         |
| Strong           | `**bold**`                                         |
| Code blocks      | Fenced with triple backticks, always               |
| Code fence info  | Preserved verbatim (e.g. `ts`, `bash showLines…`)  |
| Headings         | ATX only (`# H1` … `###### H6`), no closing hash   |
| Hard line break  | Backslash + newline (`\\\n`)                       |
| Thematic break   | `---` (three dashes, no spaces)                    |
| Link             | `[text](url)` — resource-link form, never autolink |
| List item indent | One space after the marker                         |

Fixtures in this directory follow these forms exactly. Anything else is by definition non-canonical and belongs in `../canonicalize/` (see below).

## Non-canonical inputs

Three shapes named in the task DoD do **not** round-trip byte-exact and never can while the write path emits canonical Markdown:

- Indented code blocks → fenced
- Setext headings (`=====`, `-----`) → ATX
- Two-space hard breaks (`  \n`) → backslash breaks

These are covered by paired `NAME.input.md` + `NAME.expected.md` files under `packages/markdown/src/__fixtures__/canonicalize/`. The test asserts (a) the first pass normalises input to the expected canonical form, and (b) the second pass is stable — no further changes. That's the deterministic-normalisation contract; a non-idempotent serializer would surface as a test failure there.

## Running locally

```bash
pnpm --filter=@maskin/markdown test:round-trip
```

The CI job (`.github/workflows/gfm-round-trip.yml`) runs the same command on every PR targeting `main` or `bet/tiptap-editor`. On divergence the vitest diff appears in the job log, pointing at the exact fixture and the exact byte that changed.
