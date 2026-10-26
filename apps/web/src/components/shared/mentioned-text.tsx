// Thin re-export of the packaged `MentionedText` (bet `666e3c4a`). Kept as a
// shim so consumers under `apps/web/src/components/**` continue to import from
// their existing `@/components/shared/mentioned-text` path — moving to the
// packaged module wholesale is a follow-up when the comment composer swap
// lands (Task 6+ / comment composer bet).
export { MentionedText } from '@maskin/markdown/react'
export type { MentionActor } from '@maskin/markdown/react'
