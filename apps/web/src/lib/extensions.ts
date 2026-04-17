import notetakerWebExtension from '@maskin/ext-notetaker/web'
import workWebExtension from '@maskin/ext-work/web'
import { registerWebModule } from '@maskin/module-sdk'

// Register all frontend extensions — mirrors the backend registration.
// Each extension's nav items and object type tabs become accessible
// through the module registry for dynamic UI rendering.
registerWebModule(workWebExtension)
registerWebModule(notetakerWebExtension)
