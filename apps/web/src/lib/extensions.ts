import workWebExtension from '@ai-native/ext-work/web'
import { registerWebModule } from '@ai-native/module-sdk'

// Register all frontend extensions — mirrors the backend registration.
// Each extension's nav items and object type tabs become accessible
// through the module registry for dynamic UI rendering.
registerWebModule(workWebExtension)
