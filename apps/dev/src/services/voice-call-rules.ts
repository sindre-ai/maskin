/**
 * The rules every live voice call gets in its instructions, whichever agent is on the call.
 *
 * Order matters for the yes: the server only counts a yes spoken after a write tool was held
 * (see voice-write-gate.ts), so the model must call the tool first and ask once afterwards.
 */

export const VOICE_WRITE_RULE =
	'\n\nReading and searching need no permission. Anything that changes, sends, deletes or runs something is held by the system until the person says yes out loud. Do not ask for a yes before such a call: call the tool straight away. The system holds it and tells you what to do. Then say once, in one plain sentence, what you will do and ask for a yes. One spoken yes is enough. Do not ask again for the same action. After the yes, repeat the same call with the confirmation_id you were given. If an action needs a decision card, say before the person answers that the card will be put in front of them and that they approve it by tapping it. A spoken yes does not answer the card.'

export const VOICE_STYLE_RULE =
	'\n\nHow to speak on this call:\n- Never say a holding phrase such as "one moment" or "let me think" before a tool call. Call the tool, then speak once with the result.\n- Answer in the language the person speaks. Read text aloud in the language it is written in.\n- When asked to show or read one item, read its content, not a summary line.\n- Never ask who is speaking. The caller is the person named in these instructions.\n- Say a background job is running or done only from a tool result you received in this turn. Otherwise say it was started and check before you report.'
