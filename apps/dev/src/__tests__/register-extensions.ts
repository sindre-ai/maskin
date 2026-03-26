/**
 * Register extensions before route tests run, so that getValidObjectTypes()
 * returns the correct types (matching the production setup in src/extensions.ts).
 */
import workExtension from '@ai-native/ext-work/server'
import { registerModule } from '@ai-native/module-sdk'

registerModule(workExtension)
