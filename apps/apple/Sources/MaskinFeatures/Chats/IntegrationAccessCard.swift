import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask for access to an integration that is connected but not allowed for it (the web's
/// `IntegrationAccessRequestCard`). Allow sets the agent's access on the server, the same as
/// Settings → Integrations, stops its idle session and posts a short hidden message that starts a
/// fresh one. Not now only tells the agent. Whether it was allowed is read from the integration
/// list, so a card scrolled back to says so.
struct IntegrationAccessCard: View {
	let request: IntegrationAccessRequest
	let agentID: String
	/// Who asked, for the "For {agent}" line.
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
	@State private var stillRunning = false
	/// What will be allowed: what was asked for, lowered to Read before Allow if the person wants.
	@State private var level: IntegrationAccessRequest.Level?

	/// The request as it will be answered, at the chosen level.
	private var effective: IntegrationAccessRequest {
		var copy = request
		if let level { copy.level = level }
		return copy
	}

	private var declined: Bool { declinedNow || answered == .declined }

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
				RequestCardTitle(title: "Allow \(request.displayName)?", subtitle: subtitle, symbol: "key")
				VStack(spacing: MaskinSpace.s3) {
					accessRow
					RequestCardRow(label: "Lasts", value: "Until you remove it")
				}
				if let error { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
				VStack(spacing: MaskinSpace.s4) {
					RequestCardButton(title: "Allow", primary: true, disabled: busy) { Task { await allow() } }
					RequestCardButton(title: "Not now", disabled: busy) { decline() }
				}
			}
		}
		.requestCardFrame()
		.task(id: request.integrationID) { await refresh() }
	}

	private var subtitle: String {
		(request.reason.map { $0 + " " } ?? "") + "For \(agentName ?? "this agent"). Remove it any time in Settings → Integrations."
	}

	/// What the agent gets. When it asked for read and write, Read and Read and write sit side by
	/// side so the person can lower it before Allow.
	@ViewBuilder
	private var accessRow: some View {
		if request.level == .readWrite {
			Picker(
				"Access",
				selection: Binding(get: { level ?? request.level }, set: { level = $0 })
			) {
				Text("Read").tag(IntegrationAccessRequest.Level.read)
				Text("Read and write").tag(IntegrationAccessRequest.Level.readWrite)
			}
			.pickerStyle(.segmented)
			.disabled(busy)
		} else {
			RequestCardRow(label: "Access", value: "Read")
		}
	}

	private var settledLine: String? {
		if allowedNow || state == .allowed {
			return "Allowed \(request.displayName) for this agent. It stays until you remove it."
		}
		if declined { return "Declined \(request.displayName) for \(agentName ?? "this agent")." }
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

	private func allow() async {
		guard let (access, helper) = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		do {
			let result = try await access.allow(effective)
			allowedNow = true
			if result.changed, !result.relaunched {
				// The idle session could not be stopped, so it still has the old access.
				stillRunning = true
				return
			}
			let reply = effective.allowedReply(changed: result.changed)
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
				onReply(reply, ChatSendMetadata(hiddenFromChat: true))
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
			onReply(request.declinedReply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			return
		}
		guard let card, let (_, helper) = source() else {
			error = "Couldn't tell the agent. Try again."
			return
		}
		busy = true
		error = nil
		Task {
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
}
