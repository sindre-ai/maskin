import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One conversation: the latest messages, then Dictate and a few quick replies. The system keyboard
/// on tvOS offers dictation from the Siri Remote's mic, so "Dictate" opens a text prompt that takes
/// spoken words; the chips cover the common answers without any input.
struct TVThread: View {
	@State private var chat: ChatStore
	@State private var composing = false
	@State private var draft = ""
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, conversationID: String) {
		let session = environment.auth.session
		_chat = State(
			initialValue: ChatStore(
				conversationID: conversationID, currentActorID: session?.actorId ?? "",
				currentActorName: session?.name ?? "You",
				api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
				queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
				cache: environment.snapshotCache))
	}

	private var recent: [ChatMessage] { WatchChat.recent(chat.messages, limit: 7) }

	var body: some View {
		VStack(alignment: .leading, spacing: 32) {
			Text(chat.title).font(.system(size: 48, weight: .bold)).lineLimit(1)
			VStack(alignment: .leading, spacing: 18) {
				ForEach(recent) { message in bubble(message) }
				if let working = chat.workingAgents().first {
					Text("\(working.name) is working…").font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Spacer(minLength: 0)
			if let notice = chat.notice {
				Text(notice).font(.system(size: 26)).foregroundStyle(MaskinColor.danger)
			}
			HStack(spacing: 24) {
				Button { composing = true } label: { TVCapsuleLabel(title: "Dictate", prominent: true, symbol: "mic.fill") }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				ForEach(Array(TVChat.quickReplies.enumerated()), id: \.offset) { _, phrase in
					Button { chat.send(phrase) } label: { TVCapsuleLabel(title: phrase) }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				}
				Button { dismiss() } label: { TVCapsuleLabel(title: "Back") }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
			}
		}
		.padding(.horizontal, 96)
		.padding(.vertical, 56)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.alert("Reply", isPresented: $composing) {
			TextField("Say or type your reply", text: $draft)
			Button("Send") {
				let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
				draft = ""
				if !text.isEmpty { chat.send(text) }
			}
			Button("Cancel", role: .cancel) { draft = "" }
		}
		.task { await chat.start() }
		.onDisappear { chat.stop() }
	}

	private func bubble(_ message: ChatMessage) -> some View {
		let mine = message.actorID == chat.currentActorID
		return HStack {
			if mine { Spacer(minLength: 160) }
			VStack(alignment: .leading, spacing: 6) {
				if !mine {
					Text(message.actorName).font(.system(size: 22, weight: .semibold)).foregroundStyle(MaskinColor.ink4)
				}
				Text(message.content).font(.system(size: 30)).lineLimit(5)
			}
			.padding(.horizontal, 28).padding(.vertical, 18)
			.foregroundStyle(mine ? MaskinSurface.onInverse : MaskinColor.ink)
			.background(mine ? MaskinSurface.inverse : MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
			if !mine { Spacer(minLength: 160) }
		}
	}
}

/// What the TV thread offers without any input.
enum TVChat {
	static let quickReplies = ["Yes", "No", "Thanks"]
}
