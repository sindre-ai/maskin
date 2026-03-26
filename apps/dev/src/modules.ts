// Module registration — import and register all available modules here.
// This is the single source of truth for which modules are loaded.

import workModule from '@ai-native/mod-work'
import { registerModule } from '@ai-native/module-sdk'

registerModule(workModule)

// Phase 3 will add: import notetakerModule from '@ai-native/mod-notetaker'
//   registerModule(notetakerModule)
