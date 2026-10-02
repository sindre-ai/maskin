import Foundation

/// One row of the workspace's notification inbox, reduced to what the app renders.
public struct AppNotification: Identifiable, Sendable, Equatable {
	public enum Kind: Sendable, Equatable {
		case needsInput, recommendation, goodNews, alert
		/// A type the backend added after this release.
		case other(String)

		public init(raw: String) {
			switch raw {
			case "needs_input": self = .needsInput
			case "recommendation": self = .recommendation
			case "good_news": self = .goodNews
			case "alert": self = .alert
			default: self = .other(raw)
			}
		}
	}

	public enum Status: Sendable, Equatable {
		/// Never opened: the unread state.
		case pending
		case seen
		case resolved
		case dismissed
		case other(String)

		public init(raw: String) {
			switch raw {
			case "pending": self = .pending
			case "seen": self = .seen
			case "resolved": self = .resolved
			case "dismissed": self = .dismissed
			default: self = .other(raw)
			}
		}

		public var raw: String {
			switch self {
			case .pending: "pending"
			case .seen: "seen"
			case .resolved: "resolved"
			case .dismissed: "dismissed"
			case .other(let s): s
			}
		}
	}

	/// A button the agent attached (`metadata.actions`) or a choice (`metadata.options`).
	public struct Action: Sendable, Equatable, Identifiable {
		public enum Style: Sendable, Equatable { case primary, secondary, destructive }
		public var id: String
		public var label: String
		/// What `/respond` sends back to the agent.
		public var response: JSONValue
		public var style: Style
		public var detail: String?

		public init(
			id: String, label: String, response: JSONValue, style: Style = .secondary,
			detail: String? = nil
		) {
			self.id = id
			self.label = label
			self.response = response
			self.style = style
			self.detail = detail
		}
	}

	public var id: String
	public var workspaceId: String
	public var kind: Kind
	public var title: String
	public var content: String?
	public var status: Status
	public var sourceActorId: String
	public var targetActorId: String?
	public var objectId: String?
	public var sessionId: String?
	public var createdAt: Date?
	public var resolvedAt: Date?
	/// Buttons / choices, in display order. Empty for plain informational notifications.
	public var actions: [Action]
	/// `metadata.input_type == "text"`: the agent wants free text back.
	public var wantsText: Bool
	public var placeholder: String?
	public var question: String?
	/// The answer already given (`metadata.response`), rendered once resolved.
	public var response: JSONValue?

	public init(
		id: String, workspaceId: String, kind: Kind, title: String, content: String? = nil,
		status: Status = .pending, sourceActorId: String, targetActorId: String? = nil,
		objectId: String? = nil, sessionId: String? = nil, createdAt: Date? = nil,
		resolvedAt: Date? = nil, actions: [Action] = [], wantsText: Bool = false,
		placeholder: String? = nil, question: String? = nil, response: JSONValue? = nil
	) {
		self.id = id
		self.workspaceId = workspaceId
		self.kind = kind
		self.title = title
		self.content = content
		self.status = status
		self.sourceActorId = sourceActorId
		self.targetActorId = targetActorId
		self.objectId = objectId
		self.sessionId = sessionId
		self.createdAt = createdAt
		self.resolvedAt = resolvedAt
		self.actions = actions
		self.wantsText = wantsText
		self.placeholder = placeholder
		self.question = question
		self.response = response
	}

	public var isUnread: Bool { status == .pending }

	/// Still waiting on the human: the server only accepts `/respond` while pending or seen.
	public var canRespond: Bool {
		(status == .pending || status == .seen) && (!actions.isEmpty || wantsText)
	}

	/// Where tapping the row goes, if anywhere. A notification about an object opens it.
	public func deepLink() -> DeepLink? {
		objectId.map { .object(workspaceId: workspaceId, id: $0) }
	}
}

/// A person or agent a notification came from, for the avatar and name.
public struct NotificationActor: Sendable, Equatable {
	public var id: String
	public var name: String
	public var isAgent: Bool
	public init(id: String, name: String, isAgent: Bool) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
	}
}

extension AppNotification {
	/// Builds the app model from the loosely-typed `metadata` blob the backend stores. Tolerant:
	/// malformed actions are skipped, never fatal.
	public static func make(
		id: String, workspaceId: String, type: String, title: String, content: String?,
		metadata: [String: JSONValue]?, sourceActorId: String, targetActorId: String?,
		objectId: String?, sessionId: String?, status: String, resolvedAt: Date?, createdAt: Date?
	) -> AppNotification {
		let meta = metadata ?? [:]
		var actions: [Action] = []

		for (index, value) in (meta["actions"]?.notificationItems ?? []).enumerated() {
			guard let label = value["label"]?.stringValue, !label.isEmpty else { continue }
			// An action with `navigate` and no `response` is a link, not an answer. The app has no
			// generic navigate target, so only response-carrying actions become buttons.
			guard let response = value["response"], response != .null else { continue }
			let style: Action.Style =
				switch value["variant"]?.stringValue {
				case "default": .primary
				case "destructive": .destructive
				default: .secondary
				}
			actions.append(
				Action(id: "action-\(index)", label: label, response: response, style: style))
		}
		if actions.isEmpty {
			for (index, value) in (meta["options"]?.notificationItems ?? []).enumerated() {
				guard let label = value["label"]?.stringValue, !label.isEmpty,
					let option = value["value"]?.stringValue
				else { continue }
				actions.append(
					Action(
						id: "option-\(index)", label: label, response: .string(option),
						detail: value["description"]?.stringValue))
			}
		}

		return AppNotification(
			id: id, workspaceId: workspaceId, kind: Kind(raw: type), title: title,
			content: content, status: Status(raw: status), sourceActorId: sourceActorId,
			targetActorId: targetActorId, objectId: objectId, sessionId: sessionId,
			createdAt: createdAt, resolvedAt: resolvedAt, actions: actions,
			wantsText: meta["input_type"]?.stringValue == "text",
			placeholder: meta["placeholder"]?.stringValue, question: meta["question"]?.stringValue,
			response: meta["response"])
	}
}

extension JSONValue {
	fileprivate var notificationItems: [JSONValue]? {
		if case .array(let a) = self { return a }
		return nil
	}
}
