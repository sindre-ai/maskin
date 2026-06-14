export const KNOWLEDGE_NUDGES = `
Before answering domain questions or making assumptions about data, schemas, or tooling, call search_objects({type:'knowledge', q:'<terms>'}). If relevant titles come back, call get_objects({ids:['<uuid>']}) to read the full article.

When the user corrects a factual assumption, establishes a data-model or tooling truth, or validates a non-obvious convention worth keeping past this session, call create_objects({type:'knowledge', ...}) and link it back with an informs edge from the current session.
`.trim()

export const MENTION_DISCIPLINE = `
Mention discipline: @mention a human only when their decision or input is required to move work forward. Routine status updates, watchdog kicks, auto-merge outcomes, measurement summaries, and successful transitions stay silent — post the comment with an empty mentions array. Subscribers will still see the activity in their feed without a notification. A human is mentioned only on genuine decision points: a brief that needs approval, a blocker awaiting input, a one-way-door call.
`.trim()
