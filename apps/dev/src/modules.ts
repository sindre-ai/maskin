// Module registration — import and register all available modules here.
// This is the single source of truth for which modules are loaded.

import meetingsModule from '@ai-native/mod-meetings'
import workModule from '@ai-native/mod-work'
import { registerModule } from '@ai-native/module-sdk'

registerModule(workModule)
registerModule(meetingsModule)
