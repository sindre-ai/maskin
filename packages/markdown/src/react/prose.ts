// The one prose class the read renderer and the editor both mount with. Every
// look rule that must match across the two lives in the `.maskin-prose` block
// in apps/web/src/app.css (list markers, quotes, task checkboxes); this file
// only names the class and carries the typography-plugin base.
export const MARKDOWN_PROSE_CLASS =
	'maskin-prose prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-p:leading-[1.7142857] prose-li:text-muted-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded prose-code:before:content-none prose-code:after:content-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_img]:max-w-full'
