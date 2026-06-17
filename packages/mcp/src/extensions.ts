import changelogExtension from '@maskin/ext-changelog/server'
import crmExtension from '@maskin/ext-crm/server'
import knowledgeExtension from '@maskin/ext-knowledge/server'
import notetakerExtension from '@maskin/ext-notetaker/server'
import workExtension from '@maskin/ext-work/server'
import { registerModule } from '@maskin/module-sdk'

// Mirrors apps/dev/src/extensions.ts so the standalone MCP process
// (`pnpm --filter @maskin/mcp start`) can resolve module defaults via
// getModuleDefaultSettings. Without this, get_started's template-apply
// merge no-ops and module-provided types (e.g. CRM contact/company)
// arrive at the workspace without statuses/display_names/field_definitions.
registerModule(workExtension)
registerModule(knowledgeExtension)
registerModule(notetakerExtension)
registerModule(crmExtension)
registerModule(changelogExtension)
