/**
 * Register extensions before route tests run, so that getValidObjectTypes()
 * returns the correct types (matching the production setup in src/extensions.ts).
 */
import crmExtension from '@maskin/ext-crm/server'
import knowledgeExtension from '@maskin/ext-knowledge/server'
import workExtension from '@maskin/ext-work/server'
import { registerModule } from '@maskin/module-sdk'

registerModule(workExtension)
registerModule(knowledgeExtension)
registerModule(crmExtension)
