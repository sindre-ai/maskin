-- Drop the subscribe feature.
--
-- `subscriptions` recorded who was watching an entity: 'author' (creator),
-- 'commenter' (auto-attached on comment), 'mentioned' (auto-attached on
-- @-mention), or 'manual' (the Subscribe toggle). Nothing dispatches agent
-- sessions off it — comment→session routing lives entirely in
-- CommentDispatcher (mentions → object driver → Chief of Staff) and never
-- read this table — so dropping it changes no agent behaviour.
--
-- Its two readers were:
--   * the For You unread feed, whose join predicate was already mentions-only
--     and whose subscription row was therefore a redundant gate (the feed now
--     selects FROM events directly);
--   * the bet-terminal notification fan-out, now targeted at the bet's actual
--     participants (commenters + driver + creator).
--
-- `read_state` is deliberately untouched: it is a separate table keyed on
-- (actor_id, entity_type, entity_id) and still owns read/unread.

DROP TABLE IF EXISTS "subscriptions";
