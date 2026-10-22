---
title: MCP tools
slug: mcp-tools
description: The MCP tool surface — which tools exist, what they return, and when to reach for each.
last_updated: 2026-10-21
---

# MCP tools

Stub — content pending. See parent bet.

## Workspace skills: id or name

`get_workspace_skill`, `update_workspace_skill` and `delete_workspace_skill` take the skill in their `name` argument, and that value can be either the skill's id (as listed by `list_workspace_skills`) or its name. The argument key stays `name`.

- A lowercase UUID-shaped value is tried as an id first. If no skill in the workspace has that id, it is tried as a name, so a skill that happens to be named like a UUID is still reachable.
- Any other value is tried as an exact name. There is no trimming, fuzzy matching or case-insensitive matching.
- Both lookups are scoped to the workspace in the call, so an id from another workspace is "not found".
- An unknown value returns 404 NOT_FOUND: `No skill with id or name '<value>' in this workspace. Call list_workspace_skills for valid ids and names.`
- Updates and deletes by name write to the resolved row's id, so they touch exactly one skill.

The lookup lives in the API route (`apps/dev/src/routes/workspace-skills.ts`) on top of `resolveByIdOrName` (`apps/dev/src/lib/resolve-by-id-or-name.ts`), so the web app and direct API callers get the same rule. `attach_skill_ids` and `detach_skill_ids` stay id-only.
