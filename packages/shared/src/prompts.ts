export const KNOWLEDGE_NUDGES = `
Before answering domain questions or making assumptions about data, schemas, or tooling, call search_objects({type:'knowledge', q:'<terms>'}). If relevant titles come back, call get_objects({id}) to read the full article.

When the user corrects a factual assumption, establishes a data-model or tooling truth, or validates a non-obvious convention worth keeping past this session, call create_objects({type:'knowledge', ...}) and link it back with an informs edge from the current session.
`.trim()
