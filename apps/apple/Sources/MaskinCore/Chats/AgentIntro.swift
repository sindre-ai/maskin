import Foundation

/// What an agent intro's metadata asks the app to draw (the web's `parseIntroView`): first-step
/// buttons and the tools the job needs, in place of the message's plain tail. Nil for a message
/// that carries none of the intro keys, or when any key it does carry fails to parse; then the
/// plain body shows in full and nothing extra is drawn, so the intro always reads complete.
public struct AgentIntroView: Equatable, Sendable {
	public struct Step: Equatable, Sendable {
		public var label: String
		public var prompt: String
		/// A send step sends its label as the person's message on one tap; a fill step puts the
		/// prompt in the message box and sends nothing.
		public var sends: Bool
	}

	public var steps: [Step]?
	/// Provider slugs the job needs, in the writer's order, at most three.
	public var tools: [String]?
	/// Trailing paragraphs of the body that the buttons and rows replace.
	public var plainTail: Int

	public init?(message: ChatMessage) {
		guard message.author == .agent, let metadata = message.metadata else { return nil }
		let rawSteps = metadata["suggested_steps"]
		let rawTools = metadata["needed_tools"]
		if rawSteps == nil && rawTools == nil { return nil }

		var steps: [Step]?
		if let rawSteps {
			guard case .array(let items) = rawSteps, (1...4).contains(items.count) else { return nil }
			var parsed: [Step] = []
			for item in items {
				guard let label = item["label"]?.stringValue, let prompt = item["prompt"]?.stringValue,
					let action = item["action"]?.stringValue, action == "send" || action == "fill",
					(1...60).contains(label.trimmingCharacters(in: .whitespaces).count),
					(1...200).contains(prompt.trimmingCharacters(in: .whitespaces).count)
				else { return nil }
				if action == "send" {
					// What a send step sends is exactly what it prints.
					guard prompt.trimmingCharacters(in: .whitespaces) == label.trimmingCharacters(in: .whitespaces),
						prompt.last?.isWhitespace != true
					else { return nil }
				}
				parsed.append(Step(label: label, prompt: prompt, sends: action == "send"))
			}
			steps = parsed
		}
		var tools: [String]?
		if let rawTools {
			guard case .array(let items) = rawTools, (1...3).contains(items.count) else { return nil }
			var parsed: [String] = []
			for item in items {
				guard let provider = item["provider"]?.stringValue, (1...100).contains(provider.count) else { return nil }
				parsed.append(provider)
			}
			tools = parsed
		}
		guard let tail = metadata["plain_tail"]?.intValue, tail >= 0 else { return nil }
		self.steps = steps
		self.tools = tools
		self.plainTail = tail
	}

	/// The body without its last `count` paragraphs (the plain list, the tools sentence and the
	/// closing line). Paragraphs are blank-line separated. Returns the body untouched when the count
	/// does not leave at least one paragraph, so a wrong count can only show too much, never cut
	/// the greeting.
	public static func dropPlainTail(_ content: String, count: Int) -> String {
		guard count > 0 else { return content }
		let paragraphs = content.split(separator: /\n{2,}/, omittingEmptySubsequences: false).map(String.init)
		guard count < paragraphs.count else { return content }
		return paragraphs.dropLast(count).joined(separator: "\n\n")
	}
}

extension ChatMessage {
	/// The message's text with an intro's plain tail dropped, when it is an intro the app draws.
	public var contentWithoutIntroTail: String {
		guard let intro = AgentIntroView(message: self) else { return content }
		return AgentIntroView.dropPlainTail(content, count: intro.plainTail)
	}
}
