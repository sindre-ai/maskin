import Foundation

/// A file already uploaded to the workspace, referenced from a message
/// (`metadata.attachments[]` in the API).
public struct ChatAttachmentRef: Codable, Sendable, Equatable, Hashable, Identifiable {
	public var fileID: String
	public var name: String?
	public var mimeType: String?
	public var sizeBytes: Int?

	public var id: String { fileID }

	public init(fileID: String, name: String? = nil, mimeType: String? = nil, sizeBytes: Int? = nil) {
		self.fileID = fileID
		self.name = name
		self.mimeType = mimeType
		self.sizeBytes = sizeBytes
	}

	enum CodingKeys: String, CodingKey {
		case fileID = "file_id", name, mimeType = "mime_type", sizeBytes = "size_bytes"
	}
}

/// The human's reply to an agent's question (`metadata.question_answer`).
public struct ChatQuestionAnswer: Codable, Sendable, Equatable {
	public struct Answer: Codable, Sendable, Equatable {
		public var header: String
		public var selected: [String]
		public init(header: String, selected: [String]) {
			self.header = header
			self.selected = selected
		}
	}

	public var questionMessageID: Int
	public var answers: [Answer]

	public init(questionMessageID: Int, answers: [Answer]) {
		self.questionMessageID = questionMessageID
		self.answers = answers
	}

	enum CodingKeys: String, CodingKey {
		case questionMessageID = "question_message_id", answers
	}
}

/// The client-supplied part of a message's `metadata`. Exactly the keys the API accepts, so the
/// encoded form can go straight on the wire (and be stored in the outbox).
public struct ChatSendMetadata: Codable, Sendable, Equatable {
	public static let maxAttachments = 10
	public static let maxMentions = 50

	public var attachments: [ChatAttachmentRef]?
	/// Actor ids. The backend auto-joins a mentioned agent that is not yet a participant.
	public var mentions: [String]?
	public var questionAnswer: ChatQuestionAnswer?

	public init(
		attachments: [ChatAttachmentRef]? = nil, mentions: [String]? = nil,
		questionAnswer: ChatQuestionAnswer? = nil
	) {
		self.attachments = attachments?.isEmpty == true ? nil : attachments
		self.mentions = mentions?.isEmpty == true ? nil : mentions
		self.questionAnswer = questionAnswer
	}

	enum CodingKeys: String, CodingKey {
		case attachments, mentions, questionAnswer = "question_answer"
	}

	public var isEmpty: Bool { attachments == nil && mentions == nil && questionAnswer == nil }

	/// The same data as a `JSONValue`, so an optimistic bubble reads it exactly like a server row.
	public var jsonValue: JSONValue? {
		guard !isEmpty, let data = try? JSONEncoder().encode(self) else { return nil }
		return try? JSONDecoder().decode(JSONValue.self, from: data)
	}
}

// MARK: - Reading a message's metadata

/// One question an agent asked (`metadata.question.questions[]`).
public struct ChatQuestionItem: Sendable, Equatable, Identifiable {
	public struct Option: Sendable, Equatable, Hashable {
		public var label: String
		public var detail: String?
		/// The agent's suggested choice: `recommended: true` on the option, or the
		/// "(Recommended)" suffix Claude's question tool conventionally appends to a label.
		public var recommended = false

		public init(label: String, detail: String? = nil, recommended: Bool = false) {
			self.label = label
			self.detail = detail
			self.recommended = recommended
		}

		/// `label` without a trailing "(Recommended)" / "[recommended]" decoration.
		static func strippingRecommended(_ label: String) -> String {
			let pattern = #"\s*[\(\[]\s*recommended\s*[\)\]]\s*$"#
			let stripped = label.replacingOccurrences(
				of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
			return stripped.isEmpty ? label : stripped
		}
	}

	public var index: Int
	public var header: String
	public var question: String
	public var multiSelect: Bool
	public var options: [Option]

	public var id: Int { index }

	public init(index: Int, header: String, question: String, multiSelect: Bool, options: [Option]) {
		self.index = index
		self.header = header
		self.question = question
		self.multiSelect = multiSelect
		self.options = options
	}
}

extension ChatMessage {
	public var attachments: [ChatAttachmentRef] {
		guard case .array(let items)? = metadata?["attachments"] else { return [] }
		return items.compactMap { item in
			guard let id = item["file_id"]?.stringValue else { return nil }
			return ChatAttachmentRef(
				fileID: id, name: item["name"]?.stringValue, mimeType: item["mime_type"]?.stringValue,
				sizeBytes: item["size_bytes"]?.intValue)
		}
	}

	public var mentionIDs: [String] {
		guard case .array(let ids)? = metadata?["mentions"] else { return [] }
		return ids.compactMap(\.stringValue)
	}

	/// The agent's questions, when this message carries any (backend-owned `metadata.question`).
	public var questions: [ChatQuestionItem] {
		guard case .array(let items)? = metadata?["question"]?["questions"] else { return [] }
		return items.enumerated().compactMap { index, item in
			guard let header = item["header"]?.stringValue, let question = item["question"]?.stringValue,
				case .array(let rawOptions)? = item["options"]
			else { return nil }
			let options = rawOptions.compactMap { option -> ChatQuestionItem.Option? in
				guard let raw = option["label"]?.stringValue else { return nil }
				// The answer sent back is the plain label, never the "(Recommended)" decoration.
				let label = ChatQuestionItem.Option.strippingRecommended(raw)
				// ask-user-question.sh always emits `description` (empty when the agent gave none).
				let detail = option["description"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
				return .init(
					label: label, detail: detail,
					recommended: option["recommended"]?.boolValue == true || label != raw)
			}
			guard !options.isEmpty else { return nil }
			return ChatQuestionItem(
				index: index, header: header, question: question,
				multiSelect: item["multi_select"]?.boolValue == true, options: options)
		}
	}

	/// The session whose turn asked the question.
	public var questionSessionID: String? { metadata?["question"]?["session_id"]?.stringValue }

	/// For a human reply to a question: the message it answers.
	public var answeredQuestionID: Int? { metadata?["question_answer"]?["question_message_id"]?.intValue }

	/// What the human picked, when this message answers a question.
	public var questionAnswers: [ChatQuestionAnswer.Answer] {
		guard case .array(let items)? = metadata?["question_answer"]?["answers"] else { return [] }
		return items.compactMap { item in
			guard let header = item["header"]?.stringValue, case .array(let picked)? = item["selected"]
			else { return nil }
			return .init(header: header, selected: picked.compactMap(\.stringValue))
		}
	}
}

extension JSONValue {
	var intValue: Int? {
		if case .number(let n) = self, n.rounded() == n { return Int(n) }
		return nil
	}

}
