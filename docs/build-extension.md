# Build an Extension

Maskin's module system lets you define custom object types that plug into the workspace alongside the built-in types. Extensions register their types, statuses, fields, and UI navigation — all without modifying core code.

This guide walks you through creating a new extension from scratch.

## How extensions work

An extension is a package that exports two definitions:

| Export | Purpose |
|--------|---------|
| **Server definition** (`ModuleDefinition`) | Declares object types, statuses, fields, optional routes and MCP tools |
| **Web definition** (`ModuleWebDefinition`) | Declares sidebar navigation and list page tabs for the frontend |

When registered, the extension's object types become available through all standard CRUD endpoints — no custom routes needed.

## Project structure

Extensions live in the `extensions/` directory:

```
extensions/
  my-extension/
    package.json        # Package config with server + web exports
    shared.ts           # Shared constants (module ID, name)
    server/
      index.ts          # ModuleDefinition — object types, statuses, fields
    web/
      index.ts          # ModuleWebDefinition — navigation, tabs
```

## Step 1: Create the extension package

Create the directory structure:

```bash
mkdir -p extensions/my-extension/server extensions/my-extension/web
```

Create `extensions/my-extension/package.json`:

```json
{
  "name": "@ai-native/ext-my-extension",
  "version": "0.0.1",
  "private": true,
  "exports": {
    "./server": "./server/index.ts",
    "./web": "./web/index.ts"
  }
}
```

Create `extensions/my-extension/shared.ts` with your module constants:

```typescript
export const MODULE_ID = 'my-extension'
export const MODULE_NAME = 'My Extension'
```

## Step 2: Define server-side object types

Create `extensions/my-extension/server/index.ts`:

```typescript
import type { ModuleDefinition } from '@ai-native/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared'

const myExtension: ModuleDefinition = {
  id: MODULE_ID,
  name: MODULE_NAME,
  version: '0.0.1',
  objectTypes: [
    {
      type: 'feature-request',
      label: 'Feature Request',
      icon: 'lightbulb',
      defaultStatuses: ['new', 'triaged', 'planned', 'building', 'shipped', 'declined'],
    },
    {
      type: 'bug-report',
      label: 'Bug Report',
      icon: 'bug',
      defaultStatuses: ['reported', 'confirmed', 'fixing', 'fixed', 'wont-fix'],
      defaultFields: [
        { name: 'severity', type: 'enum', values: ['critical', 'high', 'medium', 'low'] },
        { name: 'reproducible', type: 'boolean' },
      ],
    },
  ],
  defaultSettings: {
    display_names: {
      'feature-request': 'Feature Request',
      'bug-report': 'Bug Report',
    },
    statuses: {
      'feature-request': ['new', 'triaged', 'planned', 'building', 'shipped', 'declined'],
      'bug-report': ['reported', 'confirmed', 'fixing', 'fixed', 'wont-fix'],
    },
    field_definitions: {
      'bug-report': [
        { name: 'severity', type: 'enum', values: ['critical', 'high', 'medium', 'low'] },
        { name: 'reproducible', type: 'boolean' },
      ],
    },
  },
}

export default myExtension
```

### Object type definition fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Unique identifier (used in API calls and the `objects.type` column) |
| `label` | Yes | Human-readable name shown in the UI |
| `icon` | No | Icon name for the UI |
| `defaultStatuses` | Yes | Valid status values for this object type |
| `defaultFields` | No | Custom metadata fields (stored in `objects.metadata` JSONB) |

### Field types

| Type | Description |
|------|-------------|
| `text` | Free-form text |
| `number` | Numeric value |
| `date` | Date value |
| `enum` | One of a predefined set of values (specify `values` array) |
| `boolean` | True/false |

## Step 3: Define the frontend UI

Create `extensions/my-extension/web/index.ts`:

```typescript
import type { ModuleWebDefinition } from '@ai-native/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared'

const myExtensionWeb: ModuleWebDefinition = {
  id: MODULE_ID,
  name: MODULE_NAME,
  navItems: [
    { path: '/feature-requests', icon: 'lightbulb', label: 'Feature Requests' },
    { path: '/bug-reports', icon: 'bug', label: 'Bug Reports' },
  ],
  objectTypeTabs: [
    { label: 'Feature Requests', value: 'feature-request' },
    { label: 'Bug Reports', value: 'bug-report' },
  ],
  defaultSettings: {
    display_names: {
      'feature-request': 'Feature Request',
      'bug-report': 'Bug Report',
    },
    statuses: {
      'feature-request': ['new', 'triaged', 'planned', 'building', 'shipped', 'declined'],
      'bug-report': ['reported', 'confirmed', 'fixing', 'fixed', 'wont-fix'],
    },
    field_definitions: {
      'bug-report': [
        { name: 'severity', type: 'enum', values: ['critical', 'high', 'medium', 'low'] },
        { name: 'reproducible', type: 'boolean' },
      ],
    },
  },
}

export default myExtensionWeb
```

## Step 4: Register the extension

Add your extension to the backend registration file at `apps/dev/src/extensions.ts`:

```typescript
import myExtension from '@ai-native/ext-my-extension/server'
import { registerModule } from '@ai-native/module-sdk'

registerModule(myExtension)
```

Add the package to `pnpm-workspace.yaml` if not already covered by a glob pattern, and run `pnpm install` to link it.

## Step 5: Enable in a workspace

Extensions are enabled per-workspace via the `enabled_modules` setting. Update your workspace:

```bash
curl -X PATCH http://localhost:3000/api/workspaces/{workspace-id} \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "enabled_modules": ["work", "my-extension"]
    }
  }'
```

> **Important:** Include `"work"` (the built-in module) in the array to keep the default insight/bet/task types active.

## Step 6: Use your new object types

Once enabled, your custom types work through the standard API:

```bash
# Create a feature request
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "feature-request",
    "title": "Add dark mode support",
    "status": "new"
  }'

# Create a bug report with custom fields
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "bug-report",
    "title": "Login fails on Safari",
    "status": "reported",
    "metadata": {
      "severity": "high",
      "reproducible": true
    }
  }'
```

Custom object types also work with:
- **Relationships** — link them to other objects with `informs`, `breaks_into`, `blocks`, `relates_to`, or `duplicates`
- **Triggers** — set up automation triggers that fire on status changes for your custom types
- **MCP tools** — external agents can create and manage your custom types through the standard MCP tools
- **Events** — all mutations are logged in the event stream

## Reference: The built-in "work" extension

The `extensions/work/` directory is the built-in extension that provides the core object types (insight, bet, task). It's a good reference for how a production extension is structured.

## Next steps

- [API Reference](./api-reference.md) — full endpoint documentation for working with objects
- [Data Model](./data-model.md) — understand how objects and relationships are stored
- [Create your first agent team](./create-agent-team.md) — wire agents to your custom object types
