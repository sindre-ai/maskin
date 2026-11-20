import Foundation

/// The events and property keys the server's `POST /api/telemetry/client` accepts, copied from
/// `apps/dev/src/lib/analytics/client-events.ts`. The server refuses a whole batch for one unknown
/// name or key, so the phone checks each event before it is queued and drops what would not pass.
/// A new event is added in both files together.
enum AnalyticsAllowlist {
	enum Rule {
		/// Letters, digits, `_` and `-`, up to 64: an id or slug, so a sentence does not fit.
		case id
		/// A short label such as a screen name: words only, up to 40.
		case label
		/// A whole number, zero or more.
		case int
		case oneOf([String])
	}

	private static let cardKind = Rule.oneOf(["decision", "thread"])

	static let events: [String: [String: Rule]] = [
		"app_installed": [:],
		"first_sign_in": [:],
		"app_opened": [:],
		"app_active": ["utc_day": .id],
		"screen_viewed": [
			"screen": .label, "feature_area": .oneOf(AnalyticsFeatureArea.allCases.map(\.rawValue)),
		],
		"push_permission_granted": [:],
		"push_permission_denied": [:],
		"push_notification_opened": ["notification_id": .id, "type": .id],
		"foryou_card_shown": ["card_kind": cardKind, "card_id": .id],
		"foryou_card_action": ["card_kind": cardKind, "card_id": .id, "action_id": .id],
		"chat_session_started": [
			"entity_id": .id, "entity_type": .oneOf(["session"]), "source": .oneOf(["iphone"]),
			"entry_point": .id, "participant_count": .int, "entry_agent_role": .id,
		],
		"object_created": [
			"entity_id": .id, "entity_type": .oneOf(["object"]), "source": .oneOf(["iphone"]),
			"object_subtype": .id,
		],
		"object_updated": [
			"object_id": .id, "mutation_type": .id, "via": .oneOf(["single", "bulk"]),
			"bulk_batch_size": .int,
		],
		"object_viewed": ["entity_id": .id, "entity_type": .oneOf(["object"]), "object_type": .id],
		"chat_opened_from_list": ["source": .id, "section": .id, "position_bucket": .id],
		"chat_list_search_used": ["result_count_bucket": .id],
		// The two generic step events, for flows with no screen of their own.
		"flow_step": ["flow": .id, "step": .id, "flow_id": .id, "duration_ms": .int],
		"flow_error": ["flow": .id, "step": .id, "error_category": .id],
	]

	/// The properties of `event` that would pass, or nil when the event itself is not on the list.
	/// A key or value that would not pass is dropped and the event still goes out.
	static func clean(event: String, properties: AnalyticsProperties) -> AnalyticsProperties? {
		guard let allowed = events[event] else { return nil }
		return properties.filter { key, value in
			guard let rule = allowed[key] else { return false }
			return accepts(rule, value)
		}
	}

	static func accepts(_ rule: Rule, _ value: AnalyticsValue) -> Bool {
		switch (rule, value) {
		case (.int, .int(let number)): return number >= 0
		case (.id, .string(let text)): return isID(text)
		case (.label, .string(let text)): return isLabel(text)
		case (.oneOf(let choices), .string(let text)): return choices.contains(text)
		default: return false
		}
	}

	private static func isID(_ text: String) -> Bool {
		(1...64).contains(text.utf8.count)
			&& text.unicodeScalars.allSatisfy { isAlphanumeric($0) || $0 == "_" || $0 == "-" }
	}

	private static func isLabel(_ text: String) -> Bool {
		(1...40).contains(text.utf8.count)
			&& text.unicodeScalars.allSatisfy {
				isAlphanumeric($0) || $0 == " " || $0 == "_" || $0 == "." || $0 == ":" || $0 == "-"
			}
	}

	private static func isAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
		(scalar >= "a" && scalar <= "z") || (scalar >= "A" && scalar <= "Z")
			|| (scalar >= "0" && scalar <= "9")
	}
}
