import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent asking the person to act on its own computer (the web's `ComputerRequestCard`): a 2FA
/// prompt, a CAPTCHA, a confirmation. It says what to do; Done hands control back by posting a
/// hidden message, which is what wakes the agent.
///
/// The live computer view is web-only for now, so Open computer opens the chat in the browser,
/// where its card shows the computer. Done works from either place.
struct ComputerRequestCard: View {
	let request: ComputerRequest
	let agentName: String
	let conversationID: String
	let messageID: Int?
	var answered: ChatCardAnswer.Outcome?
	let onReply: (String, ChatSendMetadata) -> Void

	@Environment(\.openURL) private var openURL
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var doneNow = false
	@State private var busy = false
	@State private var error: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if doneNow || answered == .done {
				RequestCardSettled(symbol: "desktopcomputer", text: "Handed back to \(agentName).")
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text("\(agentName) needs your help on its computer")
						.maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text(request.task).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						.fixedSize(horizontal: false, vertical: true)
				}
				if let error { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
				VStack(spacing: MaskinSpace.s4) {
					if let url = webChatURL {
						RequestCardButton(title: "Open computer in browser", primary: true) { openURL(url) }
					}
					RequestCardButton(title: "Done", primary: webChatURL == nil, disabled: busy) { Task { await done() } }
				}
			}
		}
		.requestCardFrame()
	}

	/// This chat on the web, where the card draws the agent's live computer.
	private var webChatURL: URL? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		return SettingsServices(environment: runtime.environment).webBaseURL
			.appendingPathComponent(workspaceID).appendingPathComponent("chats").appendingPathComponent(conversationID)
	}

	private func done() async {
		let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .done) }
		guard request.replyToSession else {
			doneNow = true
			onReply(ComputerRequest.doneMessage, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			return
		}
		guard let card, let runtime, let workspaceID = runtime.environment.workspaceId else {
			error = "Couldn't tell the agent. Try again."
			return
		}
		busy = true
		error = nil
		defer { busy = false }
		do {
			try await APIHelperSessionSource(client: runtime.environment.client, workspaceID: workspaceID)
				.sendInput(sessionID: request.sessionID, content: ComputerRequest.doneMessage, cardAnswer: card)
			doneNow = true
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't tell the agent. Try again."
		}
	}
}
