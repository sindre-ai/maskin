import workExtension from '@ai-native/ext-work/server'
import { registerModule } from '@ai-native/module-sdk'

// Register all extensions — this is the single source of truth for which
// extensions are available in the platform. Each extension's object types,
// routes, and MCP tools become accessible through the module registry.
registerModule(workExtension)
