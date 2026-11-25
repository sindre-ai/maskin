import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask for access to an integration that is connected but not allowed for it (the web's
/// `IntegrationAccessRequestCard`). Allow sets the agent's access on the server, the same as
/// Settings → Integrations, stops its idle session and posts a short hidden message that starts a
/// fresh one. For Calendar and Meet the card can also allow write in this chat only, for a few hours.
/// Not now is counted for the Allow rate, then tells the agent. Whether it was allowed is read from
/// the integration list (or, for this chat only, from the stored answer), so a card scrolled back to
/// says so.
struct IntegrationAccessCard: View {
	let request: IntegrationAccessRequest
	let agentID: String
	/// Who asked, for "For Chief of Staff" and the settled line. Nil reads "this agent".
	var agentName: String?
	/// The card's own message id, so a decline can be recorded against it.
	let messageID: Int?
	var answered: ChatCardAnswer.Outcome?
	let onReply: (String, ChatSendMetadata) -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var state: IntegrationAccessState = .unknown
	@State private var busy = false
	@State private var error: String?
	@State private var declinedNow = false
	@State private var allowedNow = false
	@State private var chatAllowedNow = false
	@State private var stillRunning = false
	/// What the person will grant: the ask, or lower. Nil until they touch the picker.
	@State private var chosenLevel: IntegrationAccessRequest.Level?

	private var level: IntegrationAccessRequest.Level { chosenLevel ?? request.level }

	private var declined: Bool { declinedNow || answered == .declined }

	/// This chat only, for a few hours: said by the server, and only for a write ask.
	private var chatAllowed: Bool { request.lift != nil && (chatAllowedNow || answered == .done) }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if let line = settledLine {
				RequestCardDeclined(
					symbol: "key.fill", text: line,
					onAskAgain: declined && !allowedNow && state != .allowed && !request.replyToSession
						? { onReply(request.askAgainText, ChatSendMetadata()) } : nil)
				if stillRunning {
					Text("The agent is still running with its old access. Stop it from the chat, then send a message to start it again.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} else {
				RequestCardTitle(
					title: "Allow \(request.displayName)?",
					subtitle: ["For \(agentName ?? "this agent").", request.lift?.text ?? request.reason].compactMap { $0 }
						.filter { !$0.isEmpty }.joined(separator: " "),
					symbol: "key")
				accessRows
				if let error { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
				VStack(spacing: MaskinSpace.s4) {
					if let lift = request.lift, level == .readWrite {
						RequestCardButton(title: "Allow in this chat for \(lift.hours) hours", primary: true, disabled: busy) {
							Task { await allow(scope: .chat) }
						}
						RequestCardButton(title: "Always allow", disabled: busy) { Task { await allow() } }
					} else {
						RequestCardButton(title: request.lift == nil ? "Allow" : "Always allow", primary: true, disabled: busy) {
							Task { await allow() }
						}
					}
					RequestCardButton(title: "Not now", disabled: busy) { decline() }
				}
			}
		}
		.requestCardFrame()
		.task(id: request.integrationID) { await refresh() }
	}

	/// How much and how long, as two rows. The level can be lowered to Read before Allow.
	private var accessRows: some View {
		VStack(spacing: 0) {
			if let lift = request.lift {
				if let tool = lift.tool {
					infoRow("Tool asked for", tool)
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
				}
				if let reason = request.reason, !reason.isEmpty {
					infoRow("The agent says", reason)
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
				}
			}
			HStack(spacing: MaskinSpace.s4) {
				Text("Access").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				Spacer(minLength: 0)
				if request.choosableLevels.count > 1 {
					Picker("Access", selection: Binding(get: { level }, set: { chosenLevel = $0 })) {
						ForEach(request.choosableLevels, id: \.self) { Text($0.label).tag($0) }
					}
					.pickerStyle(.segmented)
					.fixedSize()
				} else {
					Text(level.label).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				}
			}
			.frame(minHeight: MaskinSpace.touchMin)
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
			infoRow(
				"Lasts",
				request.lift.map { "Allow in this chat: \($0.hours) hours. Always allow: until you remove it" }
					?? "Until you remove it")
		}
		.padding(.horizontal, MaskinSpace.s6)
		.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
	}

	/// A label and its value on one line; a long value wraps under the label's row height.
	private func infoRow(_ label: String, _ value: String) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(label).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
			Spacer(minLength: 0)
			Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink).multilineTextAlignment(.trailing)
		}
		.frame(minHeight: MaskinSpace.touchMin)
	}

	private var settledLine: String? {
		if allowedNow || state == .allowed {
			return request.allowedLine(agentName: agentName)
		}
		if chatAllowed { return request.chatAllowedLine(agentName: agentName) }
		if declined { return request.declinedLine(agentName: agentName) }
		if state == .gone { return "\(request.displayName) is no longer connected." }
		return nil
	}

	private func source() -> (IntegrationAccessing, HelperSessionReplying)? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		let client = runtime.environment.client
		return (
			APIIntegrationAccessSource(client: client, workspaceID: workspaceID),
			APIHelperSessionSource(client: client, workspaceID: workspaceID)
		)
	}

	private func refresh() async {
		guard let (access, _) = source() else { return }
		state = await access.state(for: request, agentID: agentID)
	}

	private func allow(scope: IntegrationAccessScope = .always) async {
		guard let (access, helper) = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		do {
			// Allow in this chat is always the full level; a standing Allow takes the picked one.
			let granted = scope == .chat ? request.with(level: .readWrite) : request.with(level: level)
			let result = try await access.allow(granted, scope: scope)
			if scope == .chat { chatAllowedNow = true } else { allowedNow = true }
			if result.changed, !result.relaunched {
				// The idle session could not be stopped, so it still has the old access.
				stillRunning = true
				return
			}
			let reply = scope == .chat ? request.chatAllowedReply() : granted.allowedReply(changed: result.changed)
			if request.replyToSession {
				do {
					// Stopped to take the new access, so its follow-up carries on; not stopped, so write into it.
					if result.changed {
						try await helper.continueSession(sessionID: request.sessionID, content: reply)
					} else {
						// Not stopped, so write into the running helper. Without the card's message id there is
						// nothing to record the answer against: say so rather than skip it and look done.
						guard let messageID else { throw KeychainAccessError("Couldn't tell the agent.") }
						try await helper.sendInput(
							sessionID: request.sessionID, content: reply,
							cardAnswer: ChatCardAnswer(messageID: messageID, outcome: .done))
					}
				} catch {
					stillRunning = true
				}
			} else {
				// A chat Allow leaves the standing level as it was, so the card reads its answer from here.
				let card = scope == .chat ? messageID.map { ChatCardAnswer(messageID: $0, outcome: .done) } : nil
				onReply(reply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			}
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't allow it. Try again."
		}
	}

	private func decline() {
		let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .declined) }
		guard request.replyToSession else {
			declinedNow = true
			Task {
				// Counted for the Allow rate. Never blocks the decline: the message below is what the
				// agent and a reload read, so it posts whether or not the count was recorded.
				await source()?.0.recordDecline(request)
				onReply(request.declinedReply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			}
			return
		}
		guard let card, let (access, helper) = source() else {
			error = "Couldn't tell the agent. Try again."
			return
		}
		busy = true
		error = nil
		Task {
			defer { busy = false }
			await access.recordDecline(request)
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
}
