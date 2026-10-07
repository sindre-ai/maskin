import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The For you tab: what the agents need from you, most important first. Owns its
/// `NavigationStack` and the shell toolbar.
///
/// `openObject` is the hook for the Objects slice: called with an object id when the reader opens
/// the thing a card is about. Without it the object name is plain text.
public struct ForYouScreen: View {
	private let environment: AppEnvironment
	private let openObject: ((String) -> Void)?
	@Environment(AppRuntime.self) private var appRuntime
	@State private var showNewChat = false

	public init(environment: AppEnvironment, openObject: ((String) -> Void)? = nil) {
		self.environment = environment
		self.openObject = openObject
	}

	/// Owned by `AppRuntime`; reading it is free and has no side effects.
	private var runtime: ForYouRuntime { appRuntime.forYou }

	public var body: some View {
		NavigationStack {
			ForYouFeedView(
				store: runtime.store, outbox: runtime.outbox,
				openObject: openObject, chief: runtime.chief, environment: environment,
				stories: appRuntime.storiesStore()
			)
			.shellToolbar(
				environment: environment, title: "For you",
				actions: ShellActions(
					new: { showNewChat = true }, live: true, display: ShellDisplayMenu { displayMenu })
			)
			.sheet(isPresented: $showNewChat) {
				if let chief = runtime.chief {
					NewChatSheet(
						store: chief.conversations, currentActorID: environment.auth.session?.actorId
					) { created in
						appRuntime.selectedTab = .chats
						appRuntime.requestedConversationId = created.id
					}
				}
			}
			.task(id: environment.workspaceId) {
				async let feed: Void = runtime.store.load()
				async let stories: Void = appRuntime.storiesStore()?.load() ?? ()
				_ = await (feed, stories)
			}
		}
	}

	/// The Display menu: which kind of card to show, and taking every suggested option. That acts on
	/// the store's per-card path, so each card stays individually undoable.
	@ViewBuilder private var displayMenu: some View {
		let store = runtime.store
		if !store.typeCounts.isEmpty {
			Picker(
				"Show",
				selection: Binding(
					get: { store.options.typeFilter }, set: { store.options.typeFilter = $0 })
			) {
				Text("Everything").tag(String?.none)
				ForEach(store.typeCounts, id: \.type) { item in
					Text("\(item.type.capitalized)s \(item.count)").tag(String?.some(item.type))
				}
			}
		}
		Button("Take every suggested", systemImage: "checkmark.circle") { store.takeSuggestedOptions() }
			.disabled(store.suggestedOptionCount == 0)
	}
}

/// Builds the story store for the current workspace and keeps it until the workspace changes.
@MainActor
final class StoriesProvider {
	private var current: (workspace: String, store: StoriesStore)?

	func store(for environment: AppEnvironment) -> StoriesStore? {
		guard let workspace = environment.workspaceId else { return nil }
		if let current, current.workspace == workspace { return current.store }
		let credentials = environment.auth.credentialsProvider
		let files = APIFilesRemote(client: environment.client, credentials: credentials)
		let store = StoriesStore(
			loops: APILoopsSource(
				client: environment.client, workspaceID: workspace,
				objects: APIObjectsRemote(client: environment.client, credentials: credentials),
				files: files),
			files: files, briefing: APISpokenBriefing(client: environment.client, workspaceID: workspace),
			readerName: { [weak environment] in environment?.auth.session?.name })
		current = (workspace, store)
		return store
	}
}

/// The feed itself, driven by plain stores so previews and snapshots can host it without an
/// `AppEnvironment`.
struct ForYouFeedView: View {
	@Bindable var store: ForYouStore
	let outbox: Outbox
	var openObject: ((String) -> Void)?
	/// Replies and quick questions go to the Chief of Staff through this, opening the pop-up
	/// sheet (which needs the environment to build its chat). Nil in snapshots.
	var chief: ChiefOfStaffDesk?
	var environment: AppEnvironment?
	/// The briefing cards above the feed; nil in snapshots.
	var stories: StoriesStore?
	@State private var openStory: StoryCard?
	/// Frozen "now" for snapshots; live screens pass nil.
	var fixedNow: Date?

	@Environment(\.scenePhase) private var scenePhase
	@State private var openedAt = Date()
	@AppStorage("forYou.swipeHintSeen") private var swipeHintSeen = false

	private let readableWidth: CGFloat = 680

	var body: some View {
		let entries = store.entries
		List {
			if let stories, !stories.cards.isEmpty {
				StoryRow(stories: stories) { card in
					stories.markSeen(card)
					openStory = card
				}
				.listRowSeparator(.hidden)
				.listRowBackground(Color.clear)
				.listRowInsets(EdgeInsets(top: MaskinSpace.s3, leading: MaskinSpace.s9, bottom: MaskinSpace.s3, trailing: MaskinSpace.s9))
			}
			headerRows(entries: entries)
			feedRows(entries: entries)
		}
		.listStyle(.plain)
		.scrollContentBackground(.hidden)
		.ambientBackground()
		.refreshable { await store.refresh() }
		.animation(store.isFetching ? nil : MaskinMotion.standard, value: entries.map { "\($0.id)-\($0.bucket.rawValue)" })
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active: outbox.appDidBecomeActive()
			case .background: store.decisions.commitHeld()
			default: break
			}
		}
		.sheet(item: presentedBinding) { presented in
			if let chief, let environment {
				ChiefOfStaffSheet(environment: environment, desk: chief, presented: presented)
					.presentationDetents([.medium, .large])
					.presentationDragIndicator(.visible)
			}
		}
		.storyCover(item: $openStory) { card in
			switch card.content {
			case .page(let output):
				if let environment {
					OutcomePresenter(environment: environment, output: output, sourceName: card.unit)
				}
			case .briefing(let headline, let script):
				BriefingStoryView(headline: headline, script: script)
			}
		}
		.alert(
			"Chief of Staff", isPresented: Binding(get: { chief?.notice != nil }, set: { if !$0 { chief?.notice = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(chief?.notice ?? "")
		}
	}

	private var presentedBinding: Binding<ChiefOfStaffDesk.Presented?> {
		Binding(get: { chief?.presented }, set: { if $0 == nil { chief?.dismiss() } })
	}

	// MARK: Header

	@ViewBuilder
	private func headerRows(entries: [FeedEntry]) -> some View {
		Group {
			if !outbox.isOnline {
				OfflineBanner(
					message: offlineMessage)
			}
			ForEach(outbox.failures.filter { $0.at < openedAt }) { failure in
				FailureRow(summary: failure.summary, message: failure.message) {
					outbox.dismissFailure(failure.id)
				}
			}
		}
		.modifier(ReadableRow(width: readableWidth))
	}

	private var offlineMessage: String {
		let queued = outbox.pendingCount
		guard queued > 0 else { return "You're offline. Changes will send when you reconnect." }
		return "You're offline. \(queued) \(queued == 1 ? "change" : "changes") will send when you reconnect."
	}

	// MARK: Rows

	@ViewBuilder
	private func feedRows(entries: [FeedEntry]) -> some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 3).modifier(ReadableRow(width: readableWidth))
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load your feed", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
			.modifier(ReadableRow(width: readableWidth))
		case .loaded:
			if entries.isEmpty {
				CaughtUp(filtered: store.options.typeFilter != nil)
					.modifier(ReadableRow(width: readableWidth))
			} else {
				swipeHint
				ForEach(groups(of: entries), id: \.bucket) { group in
					SectionHeader(
						title: title(for: group.bucket), count: group.entries.count,
						action: group.bucket == .fyi ? ("Mark all read", { store.dismissAllFYIs() }) : nil
					)
					.modifier(ReadableRow(width: readableWidth))
					ForEach(group.entries) { entry in feedRow(entry) }
				}
			}
		}
	}

	private func groups(of entries: [FeedEntry]) -> [(bucket: FeedBucket, entries: [FeedEntry])] {
		FeedBucket.allCases.compactMap { bucket in
			let inBucket = entries.filter { $0.section == bucket }
			return inBucket.isEmpty ? nil : (bucket, inBucket)
		}
	}

	private func title(for bucket: FeedBucket) -> String {
		switch bucket {
		case .needs: "Needs your decision"
		case .waiting: "Waiting on an agent"
		case .fyi: "Updates for you"
		case .done: "Done just now"
		}
	}

	/// One-time explanation of the two swipes, which nothing else on the card hints at.
	@ViewBuilder private var swipeHint: some View {
		if !swipeHintSeen {
			HStack(alignment: .top, spacing: MaskinSpace.s4) {
				Image(systemName: "hand.draw").accessibilityHidden(true)
				Text("Swipe right to accept the recommended option, left to mark read.")
					.maskinText(.subhead)
				Spacer(minLength: 0)
				Button("Got it") { withAnimation(MaskinMotion.standard) { swipeHintSeen = true } }
					.maskinText(.subhead).fontWeight(.semibold)
					.frame(minHeight: MaskinSpace.touchMin)
			}
			.foregroundStyle(MaskinColor.ink4)
			.modifier(ReadableRow(width: readableWidth))
		}
	}

	private func feedRow(_ entry: FeedEntry) -> some View {
		card(entry)
			.modifier(ReadableRow(width: readableWidth))
			.swipeActions(edge: .leading, allowsFullSwipe: true) {
				// Swipe right to take the agent's recommendation. Options that can't be undone
				// are never one swipe away: they keep their confirmation on the card.
				if entry.record == nil, let option = entry.card.decision?.recommended,
					!option.destructive
				{
					Button {
						DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
							.choose(option)
					} label: {
						Label(option.label, systemImage: "checkmark")
					}
					.tint(MaskinColor.success)
				}
			}
			.swipeActions(edge: .trailing, allowsFullSwipe: true) {
				if entry.record == nil {
					Button {
						dismiss(entry)
					} label: {
						Label("Mark read", systemImage: "checkmark")
					}
					.tint(MaskinColor.success)
				}
			}
	}

	private func card(_ entry: FeedEntry) -> some View {
		DecisionCardView(
			entry: entry, sender: store.senderName(of: entry.card), expanded: true,
			now: fixedNow ?? Date(),
			actions: .live(store: store, entry: entry, openObject: openObject), chief: chief)
	}

	private func dismiss(_ entry: FeedEntry) {
		MaskinHaptics.play(.selection)
		withAnimation(MaskinMotion.standard) { store.dismiss(entry.card) }
	}
}

// MARK: - Pieces

/// A quiet label above each group of cards, with its count and an optional bulk action.
private struct SectionHeader: View {
	let title: String
	let count: Int
	var action: (title: String, run: () -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			Text(title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			Text("\(count)").maskinText(.subhead).foregroundStyle(MaskinColor.ink5)
			Spacer(minLength: MaskinSpace.s3)
			if let action {
				Button(action.title, action: action.run)
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.frame(minHeight: MaskinSpace.touchMin)
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

private struct ReadableRow: ViewModifier {
	let width: CGFloat

	func body(content: Content) -> some View {
		content
			.frame(maxWidth: width)
			.frame(maxWidth: .infinity)
			.listRowSeparator(.hidden)
			.listRowBackground(Color.clear)
			.listRowInsets(EdgeInsets(top: MaskinSpace.s3, leading: MaskinSpace.s9, bottom: MaskinSpace.s3, trailing: MaskinSpace.s9))
	}
}

/// "You're caught up": the feed is genuinely empty.
struct CaughtUp: View {
	var filtered = false

	var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			Image(systemName: "checkmark")
				.font(.system(size: MaskinSpace.s12, weight: .semibold))
				.foregroundStyle(ForYouPalette.receiptCheck)
				.frame(width: MaskinSpace.touchMin * 1.2, height: MaskinSpace.touchMin * 1.2)
				.background(ForYouPalette.receiptBackground, in: Circle())
				.accessibilityHidden(true)
			Text(filtered ? "Nothing of this kind" : "You're caught up")
				.maskinText(.title).foregroundStyle(MaskinColor.ink)
			Text(
				filtered
					? "Nothing in your feed matches this filter."
					: "Nothing needs you right now. The agents keep working. You'll hear when one needs you."
			)
			.maskinText(.body).foregroundStyle(MaskinColor.ink4).multilineTextAlignment(.center)
		}
		.frame(maxWidth: .infinity)
		.padding(MaskinSpace.s12 + MaskinSpace.s4)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

/// A write that was dropped while the app was closed.
private struct FailureRow: View {
	let summary: String
	let message: String
	let dismiss: () -> Void

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("Couldn't send: \(summary)").maskinText(.subhead).fontWeight(.semibold)
				Text(message).maskinText(.caption)
			}
			Spacer(minLength: 0)
			Button("Dismiss", action: dismiss).maskinText(.subhead).fontWeight(.semibold)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.foregroundStyle(ForYouPalette.failureForeground)
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.failureBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(ForYouPalette.failureBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}
}

extension View {
	/// Stories open full screen on iPhone/iPad; elsewhere a sheet.
	@ViewBuilder
	func storyCover<Item: Identifiable, Content: View>(
		item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content
	) -> some View {
		#if os(iOS)
		fullScreenCover(item: item, content: content)
		#else
		sheet(item: item, content: content)
		#endif
	}
}
