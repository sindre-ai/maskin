---
title: MCP tools
slug: mcp-tools
description: The MCP tool surface — which tools exist, what they return, and when to reach for each.
last_updated: 2026-10-28
---

# MCP tools

Stub — content pending. See parent bet.

## Files

### Reading a file: `get_file`

`get_file` returns the stored bytes as `content` by default (`format: "raw"`). An
HTML page written by an agent, a briefing deck above all, can be mostly embedded
base64 fonts, so its raw `content` is hundreds of kilobytes of noise. Pass
`format: "text"` to read the words instead:

- `content_text` is markdown: one block per slide (`Slide N`, the `<h2>` as a
  heading), bullets, tables, links and the speaker notes held in `data-notes`.
  Styles, scripts, SVG, buttons and `data:` URIs are left out. If the page carries a
  `<script type="text/markdown" id="deck-source">`, that source is returned as is.
- Also returned: `title`, `meta_description`, `json_ld` (when present),
  `source_object_id` (when a `derived_from` or `relates_to` edge ties the file to an
  object), `contentHash`, `annotations`, `url` and `extracted: true`.
- A text file that is not HTML comes back unchanged with `extracted: false`. A
  binary file ignores `format` and returns the usual response.
- The text is computed on every read from the stored bytes. Nothing is stored, so
  it can never be stale. HTML over 8 MB is refused with a 400; read it raw.

A raw read of an HTML file over 100 KB that is mostly embedded data opens with a
`readable_with` field (for example `get_file format=text (96% of this file is
embedded fonts)`), placed before `content` so a reader that stops early still sees it.

There is no `offset` or `limit` on `get_file`. Use `format: "text"` rather than
paging raw bytes.

### Changing part of a file: `update_file` with `edits`

`update_file` takes either `content` (replace the whole file) or `edits` (change
parts of a text file), never both. `edits` is a list of `{ old, new, replace_all? }`
applied in order on the server, under the same row lock as a whole-file save:

- `old` must appear exactly once in the text as it stands after the earlier edits,
  unless `replace_all` is true. No match, or more than one match without
  `replace_all`, fails with a 400 that names the edit, and nothing is written.
- `new` is literal text; it may be empty to delete.
- Text MIME types only (not base64, not images or video). Files over 50 MB cannot
  be edited. The result must stay under the file type's size cap.
- At most 50 edits, 200,000 characters per `old` or `new`, 1,000,000 characters in
  total.
- `if_match` works as for `content`: a stale hash fails with 409 and writes nothing.
- `old` must match the stored bytes, so copy it from a raw `get_file` read, not from
  the `format: "text"` extract (which drops markup).
- The save logs an `updated` event for the file, with `editCount`.
