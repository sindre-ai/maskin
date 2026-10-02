import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The thread for one conversation: history, live messages, a composer pinned above the keyboard.
/// Takes a ready `ChatStore` so it previews and snapshots without a server.
struct ChatThreadView: View {
	let store: ChatStore
	var onShowParticipants: () -> Void = {}

	@Environment(\.scenePhase) private var scenePhase
	@State private var draft = ""
	@State private var isDictating = false
	@State private var isAtBottom = true
	@State private var hasUnseen = false

	private static let bottomID = "thread-bottom"
	private static let maxReadableWidth: CGFloat = 760

	var body: some View {
		content
			.background(MaskinSurface.grouped)
			.safeAreaInset(edge: .bottom, spacing: 0) { composer }
			.navigationTitle(store.title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .automatic) {
					Button(action: onShowParticipants) {
						Label("People", systemImage: "person.2")
					}
					.accessibilityHint("Shows who is in this conversation")
				}
			}
			.task {
				store.isActive = scenePhase == .active
				await store.start()
			}
			.onDisappear { store.stop() }
			.onChange(of: scenePhase) { _, phase in store.isActive = phase == .active }
			.alert(
				"Something went wrong",
				isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
			) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(store.notice ?? "")
			}
	}

	@ViewBuilder
	private var content: some View {
		switch store.phase {
		case .idle, .loading:
			ScrollView { LoadingSkeleton(rows: 3).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't open this chat", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if store.messages.isEmpty {
				EmptyState(
					symbol: "bubble.left.and.text.bubble.right", title: "Say hello",
					message: "Messages here reach everyone in the conversation, including agents.")
			} else {
				thread
			}
		}
	}

	private var thread: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: MaskinSpace.s5) {
					if store.hasEarlier {
						ProgressView()
							.frame(maxWidth: .infinity)
							.onAppear { loadEarlier(proxy) }
					}
					ThreadTranscript(store: store)
					Color.clear.frame(height: 1).id(Self.bottomID)
						.onAppear {
							isAtBottom = true
							hasUnseen = false
						}
						.onDisappear { isAtBottom = false }
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.top, MaskinSpace.s5)
				.padding(.bottom, MaskinSpace.s7)
				// Readable measure on iPad and Mac; full width on iPhone.
				.frame(maxWidth: Self.maxReadableWidth)
				.frame(maxWidth: .infinity)
			}
			.defaultScrollAnchor(.bottom)
			.scrollDismissesKeyboard(.interactively)
			.onChange(of: store.messages.last?.id) { _, _ in
				// Follow new messages only while the reader is at the bottom (or just sent one);
				// otherwise leave them where they are and offer a jump.
				if isAtBottom || store.messages.last?.actorID == store.currentActorID {
					scrollToBottom(proxy)
				} else {
					hasUnseen = true
				}
			}
			.overlay(alignment: .bottom) {
				if !isAtBottom {
					Button {
						scrollToBottom(proxy)
					} label: {
						Label(hasUnseen ? "New messages" : "Latest", systemImage: "arrow.down")
							.maskinText(.subhead)
							.padding(.horizontal, MaskinSpace.s8)
							.padding(.vertical, MaskinSpace.s4)
							.foregroundStyle(MaskinColor.ink)
							.maskinGlassCapsule(interactive: true)
					}
					.buttonStyle(.plain)
					.padding(.bottom, MaskinSpace.s5)
					.transition(.opacity.combined(with: .scale(scale: 0.9)))
				}
			}
			.animation(MaskinMotion.standard, value: isAtBottom)
		}
	}

	private var composer: some View {
		GlassComposer(
			text: $draft, isDictating: $isDictating, placeholder: "Message \(store.title)",
			onSend: send
		)
		.frame(maxWidth: Self.maxReadableWidth)
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s3)
		.frame(maxWidth: .infinity)
	}

	private func send() {
		guard store.send(draft) != nil else { return }
		draft = ""
	}

	private func scrollToBottom(_ proxy: ScrollViewProxy) {
		hasUnseen = false
		withAnimation(MaskinMotion.standard) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
	}

	/// Paging into the past keeps the reader's place: re-anchor to what was the oldest row.
	private func loadEarlier(_ proxy: ScrollViewProxy) {
		guard !store.isLoadingEarlier, let oldest = store.messages.first?.id else { return }
		Task {
			await store.loadEarlier()
			proxy.scrollTo(oldest, anchor: .top)
		}
	}
}

/// The messages, day separators and "working" row, without scrolling. Split out so it renders
/// in snapshot tests (`ImageRenderer` doesn't draw scroll views). `lazy: false` swaps the lazy
/// stack for a plain one there.
struct ThreadTranscript: View {
	let store: ChatStore
	var lazy = true
	var now = Date()

	var body: some View {
		if lazy {
			LazyVStack(alignment: .leading, spacing: MaskinSpace.s5) { rows }
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) { rows }
		}
	}

	@ViewBuilder
	private var rows: some View {
		ForEach(ThreadLayout.items(for: store.messages)) { item in
			row(item)
		}
		TimelineView(.periodic(from: now, by: 15)) { context in
			let agents = store.workingAgents(at: context.date)
			if !agents.isEmpty {
				WorkingIndicator(agents: agents).transition(.opacity)
			}
		}
	}

	@ViewBuilder
	private func row(_ item: ThreadItem) -> some View {
		switch item {
		case .daySeparator(let day):
			ThreadDivider(label: ThreadLayout.dayLabel(day, now: now))
		case .system(let message):
			ThreadDivider(label: message.content)
		case .message(let message, let showsAuthor):
			MessageRow(
				message: message, isOwn: message.actorID == store.currentActorID, showsAuthor: showsAuthor,
				onRetrySend: { store.retrySend(message.id) },
				onDiscard: { store.discard(message.id) },
				onRetryAgent: { Task { await store.retryAgent(for: message) } }
			)
			.padding(.top, showsAuthor ? MaskinSpace.s4 : 0)
		}
	}
}
