import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Chief of Staff's avatar: the app's own agent avatar, so its initials and tint match
/// everywhere else the agent appears.
struct ChiefOfStaffTile: View {
	var size: CGFloat = MaskinSpace.s12

	var body: some View {
		ActorAvatar(name: "Chief of Staff", kind: .agent, size: size)
	}
}

/// Three questions specific to the card, shown above its composer while it is focused. Tapping
/// one sends it as the reader's message.
struct QuickQuestionChips: View {
	let questions: [String]
	let ask: (String) -> Void

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s3) {
				ForEach(questions, id: \.self) { question in
					Button { ask(question) } label: {
						Text(question)
							.font(MaskinTypeface.sans(MaskinFontSize.t13_5, weight: .semibold))
							.foregroundStyle(MaskinColor.ink)
							.padding(.horizontal, MaskinSpace.s7)
							.frame(minHeight: MaskinSpace.s14)
							.background(MaskinSurface.fill, in: Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
				}
			}
		}
		.scrollClipDisabled()
	}
}

/// The Chief of Staff pop-up: a bottom sheet over For You holding the real conversation about the
/// card's object. The thread, composer, bubbles and agent replies are the Chats ones.
struct ChiefOfStaffSheet: View {
	let environment: AppEnvironment
	let desk: ChiefOfStaffDesk
	let presented: ChiefOfStaffDesk.Presented
	/// Closes the thread where it is not a sheet (the iPad detail column). Nil: dismiss the sheet.
	var onClose: (() -> Void)?

	@Environment(\.dismiss) private var dismiss
	@State private var holder = Holder()
	@State private var showParticipants = false

	@MainActor
	private final class Holder {
		var built: (chat: ChatStore, composer: ChatComposerModel)?
		var sent = false
	}

	private func make() -> (chat: ChatStore, composer: ChatComposerModel) {
		let session = environment.auth.session
		let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		let chat = ChatStore(
			conversationID: presented.conversationID, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		chat.onMarkedRead = { [conversations = desk.conversations] id, _ in
			Task { await conversations.markRead(id, serverAlreadyKnows: true) }
		}
		return (chat, ChatComposerModel(uploader: source, selfActorID: session?.actorId ?? ""))
	}

	var body: some View {
		let built = holder.built ?? make()
		let _ = { holder.built = built }()
		NavigationStack {
			VStack(spacing: 0) {
				header
				Divider()
				ChatThreadView(
					store: built.chat, composer: built.composer, conversations: desk.conversations,
					onShowParticipants: { showParticipants = true })
			}
			#if os(iOS)
			.toolbar(.hidden, for: .navigationBar)
			#endif
		}
		.ambientBackground(showsBottom: false)
		.task { sendPending(built) }
		.sheet(isPresented: $showParticipants) {
			PeopleSheet(chat: built.chat, conversations: desk.conversations)
				.presentationDetents([.medium, .large])
		}
	}

	/// The message that opened the sheet goes out once, through the same queue as any chat send.
	private func sendPending(_ built: (chat: ChatStore, composer: ChatComposerModel)) {
		guard !holder.sent, let pending = desk.takePending() else { return }
		holder.sent = true
		if built.chat.send(pending.text, metadata: pending.metadata) == nil {
			built.composer.text = pending.text
		}
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s7) {
			ChiefOfStaffTile(size: MaskinSpace.s14 + MaskinSpace.s3)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text("Chief of Staff").maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
				Text(ChiefOfStaffThreads.title(for: presented.card))
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s3)
			Button { if let onClose { onClose() } else { dismiss() } } label: {
				Image(systemName: "xmark")
					.font(.system(size: MaskinFontSize.t13, weight: .bold))
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			}
			.accessibilityLabel("Close")
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s4)
		.accessibilityElement(children: .contain)
	}
}
