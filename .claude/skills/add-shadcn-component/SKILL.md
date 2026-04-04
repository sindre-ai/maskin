---
name: add-shadcn-component
description: Properly adds a shadcn/ui component to the project via the official CLI
user-invocable: true
---

# Add shadcn/ui Component

Use this skill to add a new shadcn/ui component to the project. Never hand-write UI primitives — always use the CLI.

## Usage

The user will specify which component to add (e.g., "add the accordion component").

## Steps

1. **Check if it already exists**: Look in `apps/web/src/components/ui/` for the component
2. **Install via CLI**:
   ```bash
   cd apps/web && npx shadcn@latest add <component> --yes
   ```
3. **Verify**: Check that the file was created in `apps/web/src/components/ui/`
4. **Report**: Tell the user what was added and the import path (`@/components/ui/<component>`)

## Notes

- The `--yes` flag accepts all defaults (no interactive prompts)
- The CLI reads `apps/web/components.json` for configuration (aliases, paths, style)
- If the component has dependencies (e.g., Dialog depends on Portal), the CLI installs them automatically
- Do NOT modify the generated component file — use it as-is
