import Foundation

#if canImport(AppIntents)
	import AppIntents

	// The Siri / Shortcuts / Spotlight surface. Every intent is a thin shell over `IntentsService`
	// (unit-tested); nothing here decides anything.
	//
	// WHERE THEY RUN: intents declared in the app bundle run in the app process, started in the
	// background by the system with no UI. `MaskinIntentsPackage` makes them discoverable from the
	// app target, and an extension that links MaskinCore can include the same package, because the
	// service reads its own session from the shared Keychain and needs no app state.

	/// Process-wide access to the service. `configure` is called once by the host (the app reads
	/// its API origin from Info.plist); an intent that runs before that falls back to production.
	public enum MaskinIntentsContext {
		private static let lock = NSLock()
		nonisolated(unsafe) private static var service: IntentsService?

		/// Sign-out: drop the cached agents, thread links and Spotlight entries.
		public static func wipe() async { await current.wipe() }

		public static func configure(baseURL: URL, clientSource: String = "ios") {
			lock.withLock { service = .live(baseURL: baseURL, clientSource: clientSource) }
		}

		static var current: IntentsService {
			lock.withLock {
				if let service { return service }
				let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
				let url = raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
				let made = IntentsService.live(baseURL: url)
				service = made
				return made
			}
		}
	}

	public struct MaskinIntentsPackage: AppIntentsPackage {}

	// MARK: Entity

	public struct AgentEntity: AppEntity {
		public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Agent")
		public static let defaultQuery = AgentEntityQuery()

		public var id: String
		public var name: String
		public var role: String

		public init(_ agent: IntentAgent) {
			id = agent.id
			name = agent.name
			role = agent.role
		}

		public var displayRepresentation: DisplayRepresentation {
			DisplayRepresentation(title: "\(name)", subtitle: "\(role)")
		}
	}

	public struct AgentEntityQuery: EntityStringQuery {
		public init() {}

		public func entities(for identifiers: [String]) async throws -> [AgentEntity] {
			await MaskinIntentsContext.current.agents(ids: identifiers).map(AgentEntity.init)
		}

		public func entities(matching string: String) async throws -> [AgentEntity] {
			await MaskinIntentsContext.current.agents(matching: string).map(AgentEntity.init)
		}

		public func suggestedEntities() async throws -> [AgentEntity] {
			await MaskinIntentsContext.current.agents().map(AgentEntity.init)
		}
	}

	// MARK: Open a thread

	/// Hands a `maskin://` link to the app. The app registers `handler` once its router exists;
	/// a link that arrives earlier (an intent that launched the app cold) waits in `pending`.
	@MainActor
	public enum IntentDeepLinkRelay {
		public private(set) static var pending: URL?
		private static var handler: ((URL) -> Void)?
		private static var agentHandler: ((String) -> Void)?

		/// `openAgent` is where a tapped agent with no direct thread lands (its detail).
		public static func attach(
			openAgent: @escaping (String) -> Void = { _ in }, _ handler: @escaping (URL) -> Void
		) {
			self.handler = handler
			self.agentHandler = openAgent
			if let url = pending {
				pending = nil
				handler(url)
			}
		}

		public static func open(_ url: URL) {
			if let handler { handler(url) } else { pending = url }
		}

		/// A tapped Spotlight result for an agent. Resolves the agent's direct thread, then opens it.
		public static func openSpotlight(identifier: String) async {
			guard let agentID = SpotlightAgentLink.agentID(fromIdentifier: identifier) else { return }
			// No direct thread yet (or the lookup failed): show the agent rather than do nothing.
			if let link = try? await MaskinIntentsContext.current.threadLink(agentID: agentID) {
				open(link.url)
			} else {
				agentHandler?(agentID)
			}
		}
	}

	// MARK: Intents

	public struct WhatNeedsMeIntent: AppIntent {
		public static let title: LocalizedStringResource = "What needs me?"
		public static let description = IntentDescription(
			"Tells you how many decisions your agents are waiting on, and the most urgent one.",
			categoryName: "For you")
		/// Decision titles are private: don't read them out on a locked device.
		public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

		public init() {}

		public func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
			let summary = await MaskinIntentsContext.current.whatNeedsMe()
			return .result(value: summary.detail, dialog: IntentDialog(stringLiteral: summary.spoken))
		}
	}

	public struct AskAgentIntent: AppIntent {
		public static let title: LocalizedStringResource = "Ask an agent"
		public static let description = IntentDescription(
			"Sends a message to one of your agents. It is queued, so it goes out even if you are offline.",
			categoryName: "Chats")

		@Parameter(title: "Agent", requestValueDialog: "Which agent?")
		public var agent: AgentEntity

		@Parameter(title: "Message", requestValueDialog: "What do you want to ask?")
		public var message: String

		public static var parameterSummary: some ParameterSummary {
			Summary("Ask \(\.$agent) \(\.$message)")
		}

		public init() {}

		public init(agent: AgentEntity, message: String) {
			self.agent = agent
			self.message = message
		}

		public func perform() async throws -> some IntentResult & ProvidesDialog {
			do {
				let outcome = try await MaskinIntentsContext.current.ask(agentID: agent.id, message: message)
				let line =
					switch outcome {
					case .queued: "Queued your message for \(agent.name). It sends as soon as you're online."
					case .started: "Started a conversation with \(agent.name)."
					}
				return .result(dialog: IntentDialog(stringLiteral: line))
			} catch let error as IntentsError {
				throw AgentIntentError(error.message)
			}
		}
	}

	public struct RunAgentIntent: AppIntent {
		public static let title: LocalizedStringResource = "Run an agent"
		public static let description = IntentDescription(
			"Starts one of your agents, optionally with a prompt.", categoryName: "Agents")

		@Parameter(title: "Agent", requestValueDialog: "Which agent should run?")
		public var agent: AgentEntity

		@Parameter(title: "Prompt")
		public var prompt: String?

		public static var parameterSummary: some ParameterSummary {
			Summary("Run \(\.$agent) with \(\.$prompt)")
		}

		public init() {}

		public init(agent: AgentEntity, prompt: String? = nil) {
			self.agent = agent
			self.prompt = prompt
		}

		public func perform() async throws -> some IntentResult & ProvidesDialog {
			do {
				try await MaskinIntentsContext.current.run(agentID: agent.id, prompt: prompt)
				return .result(dialog: IntentDialog(stringLiteral: "\(agent.name) is on it."))
			} catch let error as IntentsError {
				throw AgentIntentError(error.message)
			}
		}
	}

	public struct OpenAgentThreadIntent: AppIntent {
		public static let title: LocalizedStringResource = "Open an agent's chat"
		public static let description = IntentDescription(
			"Opens your conversation with an agent in Maskin.", categoryName: "Chats")
		public static let openAppWhenRun = true

		@Parameter(title: "Agent", requestValueDialog: "Which agent?")
		public var agent: AgentEntity

		public static var parameterSummary: some ParameterSummary {
			Summary("Open \(\.$agent)")
		}

		public init() {}

		public init(agent: AgentEntity) { self.agent = agent }

		@MainActor
		public func perform() async throws -> some IntentResult {
			let link: DeepLink?
			do {
				link = try await MaskinIntentsContext.current.threadLink(agentID: agent.id)
			} catch let error as IntentsError {
				throw AgentIntentError(error.message)
			}
			guard let link else {
				throw AgentIntentError("You haven't talked to \(agent.name) yet. Ask them something first.")
			}
			IntentDeepLinkRelay.open(link.url)
			return .result()
		}
	}

	/// An error whose text Siri speaks and Shortcuts shows.
	public struct AgentIntentError: Error, CustomLocalizedStringResourceConvertible {
		let text: String
		init(_ text: String) { self.text = text }
		public var localizedStringResource: LocalizedStringResource { "\(text)" }
	}
#endif
