import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

// Shared remark plugin list consumed by the SPA reader (`react-markdown` in
// `apps/web`) and the server renderer (`unified` in `apps/dev`). Keeping this
// list in one place is the single point that guarantees the public HTML and
// the in-app edit view read the same markdown dialect (ADR-1).
export const remarkPlugins = [remarkGfm, remarkBreaks] as const
