export const KNOWLEDGE_NUDGES = `
Before answering domain questions or making assumptions about data, schemas, or tooling, call search_objects({type:'knowledge', q:'<terms>'}). If relevant titles come back, call get_objects({id}) to read the full article.

When the user corrects a factual assumption, establishes a data-model or tooling truth, or validates a non-obvious convention worth keeping past this session, call create_objects({type:'knowledge', ...}). If you were triggered by a specific object (bet, task, or insight), add an informs relationship from that object to the new knowledge article.
`.trim()
