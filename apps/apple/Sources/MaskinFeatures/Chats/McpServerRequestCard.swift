import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask to add a tool (MCP) server (the web's `McpServerRequestCard`). It shows exactly
/// what would run or be reached, and a field for each secret the server needs. Add saves the server,
/// gives it to the agent that asked, stops that agent's idle session and posts a hidden reply that
/// starts a fresh one with the server attached. The secrets are typed here and go straight into the
/// server's settings: they never pass through the agent or the message.
struct McpServerRequestCard: View {
	let request: McpServerRequest
	/// The agent that asked: the one the server is given to.
	let agentID: String
	let messageCreatedAt: Date?
	/// The card's own message id, so the answer can be recorded against it.
	let messageID: Int?
	/// How the card was already answered (read from the chat), so it says so after a reload.
	var answered: ChatCardAnswer.Outcome?
	/// Posts the person's reply into the chat; it is hidden from the chat, as on the web.
	let onReply: (String, ChatSendMetadata) -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var name: String
	@State private var secretEnv: [String: String] = [:]
	@State private var secretHeaders: [String: String] = [:]
	@State private var busy = false
	@State private var error: String?
	/// Saved but not yet given to the agent (the second step failed): a retry only gives access.
	@State private var savedID: String?
	@State private var addedName: String?
	/// Added earlier (a reload, another device) and whether the agent has it: see `addedServer`.
	@State private var earlier: AddedMcpServer?
	@State private var declinedNow = false
	@State private var stillRunning = false

	init(
		request: McpServerRequest, agentID: String, messageCreatedAt: Date?, messageID: Int?,
		answered: ChatCardAnswer.Outcome?, onReply: @escaping (String, ChatSendMetadata) -> Void
	) {
		self.request = request
		self.agentID = agentID
		self.messageCreatedAt = messageCreatedAt
		self.messageID = messageID
		self.answered = answered
		self.onReply = onReply
		_name = State(initialValue: request.name)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if let line = settledLine {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Image(systemName: "puzzlepiece.extension").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
					Text(line).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				}
				.accessibilityElement(children: .combine)
				if stillRunning {
					Text("The agent is still running without it. Stop it from the chat, then send a message to start it again with the server.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} else {
				form
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.padding(.top, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
		.task(id: request.sessionID) {
			guard let source = source() else { return }
			earlier = await source.addedServer(for: request, agentID: agentID, after: messageCreatedAt)
		}
	}

	private var shape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
	}

	private var declined: Bool { declinedNow || answered == .declined }

	/// Saved but not given to the agent: only the grant is left, so no secrets are asked for again.
	private var savedServerID: String? { savedID ?? (earlier.flatMap { $0.givenToAgent ? nil : $0.id }) }

	/// What to say once the card has been answered; nil while it asks.
	private var settledLine: String? {
		if let addedName { return "Added \(addedName) and gave it to this agent." }
		// Only "given" counts as done: a server saved whose grant failed offers to give it instead.
		if let earlier, earlier.givenToAgent { return "Added \(earlier.name) and gave it to this agent." }
		if answered == .done { return "Added \(request.name) and gave it to this agent." }
		if declined { return "Declined \(request.name)." }
		return nil
	}

	@ViewBuilder
	private var form: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text("Add the \(request.name) tool server?")
				.maskinText(.headline).foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
			Text(
				(request.hint.map { $0 + " " } ?? "")
					+ "It is saved for this workspace and given to this agent only, with read and write access. You can change that in Settings."
			)
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			.fixedSize(horizontal: false, vertical: true)
		}
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			if let commandLine = request.commandLine {
				Text("Runs this command inside the agent").maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				Text(commandLine)
					.maskinText(.caption).monospaced().foregroundStyle(MaskinColor.ink2)
					.textSelection(.enabled)
					.fixedSize(horizontal: false, vertical: true)
			}
			if let url = request.url {
				Text("Connects to").maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				Text(url)
					.maskinText(.caption).monospaced().foregroundStyle(MaskinColor.ink2)
					.textSelection(.enabled)
					.fixedSize(horizontal: false, vertical: true)
			}
			ForEach(request.givenValues, id: \.self) { line in
				Text(line).maskinText(.caption).monospaced().foregroundStyle(MaskinColor.ink4)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		if savedServerID != nil {
			Text("The server is added. Give it to this agent to finish; nothing more to type.")
				.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		} else {
			field("Name") {
				TextField("Name", text: $name).plainInput()
			}
			ForEach(request.secretEnv, id: \.self) { key in
				field(key) {
					SecureField("Paste the value", text: binding($secretEnv, key)).textContentType(.password)
				}
			}
			ForEach(request.secretHeaders, id: \.self) { key in
				field(key) {
					SecureField("Paste the value", text: binding($secretHeaders, key)).textContentType(.password)
				}
			}
			if !request.secretEnv.isEmpty || !request.secretHeaders.isEmpty {
				Text("What you type goes straight into the server's settings, so the agent never sees it.")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
		if let error {
			Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
		}
		VStack(spacing: MaskinSpace.s4) {
			choice(busy ? "Adding…" : (savedServerID != nil ? "Give to this agent" : "Add"), primary: true, enabled: canAdd) {
				await add()
			}
			choice("Not now", primary: false, enabled: !busy) { await decline() }
		}
	}

	private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text(title).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
			content()
				.maskinText(.body)
				.padding(.horizontal, MaskinSpace.s6)
				.frame(minHeight: MaskinSpace.touchMin)
				.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		}
	}

	private func binding(_ values: Binding<[String: String]>, _ key: String) -> Binding<String> {
		Binding(get: { values.wrappedValue[key] ?? "" }, set: { values.wrappedValue[key] = $0 })
	}

	private func choice(
		_ title: String, primary: Bool, enabled: Bool, action: @escaping () async -> Void
	) -> some View {
		Button {
			MaskinHaptics.play(.light)
			Task { await action() }
		} label: {
			Text(title)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(primary ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.background {
					if primary {
						Capsule().fill(MaskinSurface.inverse)
					} else {
						Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1)
					}
				}
				.opacity(enabled ? 1 : 0.35)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!enabled)
	}

	private var canAdd: Bool {
		// Once saved the secrets are cleared, so a retry after a failed grant only needs a name.
		!busy && !name.trimmingCharacters(in: .whitespaces).isEmpty
			&& (savedServerID != nil || request.isComplete(env: secretEnv, headers: secretHeaders))
	}

	private func source() -> McpServerAdding? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		let env = runtime.environment
		return APIMcpServerSource(
			client: env.client, workspaceID: workspaceID, baseURL: env.baseURL, clientSource: env.clientSource,
			credentials: env.auth.credentialsProvider)
	}

	private func helper() -> HelperSessionReplying? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		return APIHelperSessionSource(client: runtime.environment.client, workspaceID: workspaceID)
	}

	private func add() async {
		guard canAdd, let source = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
		do {
			let id: String
			if let savedServerID {
				id = savedServerID
			} else {
				id = try await source.save(
					name: displayName, server: request.server(env: secretEnv, headers: secretHeaders))
				savedID = id
				// The values are gone from the screen the moment they are saved.
				secretEnv = [:]
				secretHeaders = [:]
			}
			let relaunched = try await source.allow(serverID: id, for: request)
			addedName = displayName
			guard relaunched else {
				// The idle session could not be stopped, so it still lacks the server.
				stillRunning = true
				return
			}
			let reply = request.addedReply(name: displayName)
			if request.replyToSession {
				do {
					try await helper()?.continueSession(sessionID: request.sessionID, content: reply)
				} catch {
					// The server is added and given; only the agent's restart failed.
					stillRunning = true
				}
			} else {
				let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .done) }
				onReply(reply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			}
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't add. Try again."
		}
	}

	private func decline() async {
		let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .declined) }
		guard request.replyToSession else {
			declinedNow = true
			onReply(request.declinedReply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			return
		}
		guard let card, let helper = helper() else { return }
		busy = true
		error = nil
		defer { busy = false }
		do {
			try await helper.sendInput(sessionID: request.sessionID, content: request.declinedReply, cardAnswer: card)
			declinedNow = true
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't tell the agent. Try again."
		}
	}
}

private extension View {
	/// No auto-capitalisation or correction (iOS only; the modifiers don't exist on macOS).
	@ViewBuilder
	func plainInput() -> some View {
		#if os(iOS)
		self.textInputAutocapitalization(.never).autocorrectionDisabled()
		#else
		self.autocorrectionDisabled()
		#endif
	}
}
