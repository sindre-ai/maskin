/**
 * The `instructions` text the Maskin MCP server sends at connect.
 *
 * Under tool search a client loads only tool names until a tool is searched for, so this text is
 * one of the few things every session always sees. It does two jobs: a map of what the rarely used
 * tools can do (so the agent knows to search for them), and the rules that hold for every tool.
 *
 * Keep it under MAX_INSTRUCTIONS_LENGTH: Claude Code cuts a server's instructions at 2,048
 * characters. server-instructions.test.ts pins the length, and that every tool named here exists.
 */
export const MAX_INSTRUCTIONS_LENGTH = 2000

export const SERVER_INSTRUCTIONS = `Maskin tools. get_objects, list_objects, create_objects, update_objects, get_comments, create_comment, list_relationships, update_notification, list_sessions and list_actors are loaded in full. Search for any other tool by name before its first call, so you see its parameters.

What the rarer tools do:
- Graph: create_relationship and delete_relationship link objects; traverse_graph walks several hops from one object.
- query_data: counts or sums objects, grouped by field or time. No SQL, no rows.
- Workspace: get_workspace_schema (statuses, metadata fields, relationship types), workspace fields and skills, list_workspaces.
- Actors: get_actor, create_actor, update_actor, delete_agent, update_integration_access.
- Files: create_file, list_files, get_file, update_file, propose_file_changes, transcribe_file.
- Chats: list_chats, create_chat, create_sub_chat (ask another agent now), post_conversation_message, ask_user_question.
- Sessions: get_session, get_session_logs, send_session_message, pause_session, resume_session, stop_session.
- Triggers and flows: the trigger tools, and the loop tools (create_loop, update_loop, get_loop, set_loop_view).
- Inbox: create_notification, list_for_you, list_unread, mark_read, withdraw_decision_card.
- Integrations and mail: connect_integration, request_integration_access, add_mcp_server, resend_send_email, gmail_send_email.
- desktop_* tools drive a remote computer.

Rules for every tool:
- Ids in arguments are UUIDs. In text a person reads, use titles, not UUIDs.
- Call get_workspace_schema before you create or update objects: statuses, metadata fields and relationship types differ per workspace.
- Use the parameter names in the tool definition. Old names are still accepted, and the reply names the current one when you use one.
- Lists are paged: pass next_cursor back as cursor, with the same filters.
- create_objects and update_objects take arrays, so one call can change many objects.`
