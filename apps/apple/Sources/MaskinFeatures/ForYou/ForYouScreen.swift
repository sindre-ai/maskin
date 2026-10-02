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

	public init(environment: AppEnvironment, openObject: ((String) -> Void)? = nil) {
		self.environment = environment
		self.openObject = openObject
	}

	/// Owned by `AppRuntime`; reading it is free and has no side effects.
	private var runtime: ForYouRuntime { appRuntime.forYou }

	public var body: some View {
		NavigationStack {
			ForYouFeedView(
				store: runtime.store, outbox: runtime.outbox, greetingName: firstName,
				openObject: openObject
			)
			.navigationTitle("For you")
			.shellToolbar(environment: environment)
			.task(id: environment.workspaceId) { await runtime.store.load() }
		}
	}

	private var firstName: String? {
		environment.auth.session?.name.split(separator: " ").first.map(String.init)
	}
}

/// The feed itself, driven by plain stores so previews and snapshots can host it without an
/// `AppEnvironment`.
struct ForYouFeedView: View {
	@Bindable var store: ForYouStore
	let outbox: Outbox
	var greetingName: String?
	var openObject: ((String) -> Void)?
	/// Frozen "now" for snapshots; live screens pass nil.
	var fixedNow: Date?

	@Environment(\.scenePhase) private var scenePhase
	@State private var openIds: Set<String> = []
	@State private var showBrief = false
	@State private var openedAt = Date()

	private let readableWidth: CGFloat = 680

	var body: some View {
		let entries = store.entries
		List {
			headerRows(entries: entries)
			feedRows(entries: entries)
		}
		.listStyle(.plain)
		.scrollContentBackground(.hidden)
		.background(MaskinSurface.grouped)
		.refreshable { await store.refresh() }
		.animation(MaskinMotion.standard, value: entries.map { "\($0.id)-\($0.bucket.rawValue)" })
		.sheet(isPresented: $showBrief) {
			BriefSheet(
				state: store.brief, reload: { Task { await store.loadBrief() } },
				done: { showBrief = false }
			)
			.task { if store.brief == .idle { await store.loadBrief() } }
		}
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active: outbox.appDidBecomeActive()
			case .background: store.decisions.commitHeld()
			default: break
			}
		}
		.toolbar { ToolbarItem(placement: .secondaryAction) { displayMenu } }
	}

	// MARK: Header

	@ViewBuilder
	private func headerRows(entries: [FeedEntry]) -> some View {
		Group {
			Text(greeting)
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityLabel(greeting)
			if store.isRefreshing {
				Label("Asking the agents what changed…", systemImage: "sparkles")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			if !outbox.isOnline {
				OfflineBanner(
					message: offlineMessage)
			}
			ForEach(outbox.failures.filter { $0.at < openedAt }) { failure in
				FailureRow(summary: failure.summary, message: failure.message) {
					outbox.dismissFailure(failure.id)
				}
			}
			BriefPill { showBrief = true }
			if store.phase == .loaded, !entries.isEmpty {
				sectionLabel(entries: entries)
			}
		}
		.modifier(ReadableRow(width: readableWidth))
	}

	private var greeting: String {
		let hour = Calendar.current.component(.hour, from: fixedNow ?? Date())
		let part = hour < 12 ? "Good morning" : (hour < 18 ? "Good afternoon" : "Good evening")
		return greetingName.map { "\(part), \($0)" } ?? part
	}

	private var offlineMessage: String {
		let queued = outbox.pendingCount
		guard queued > 0 else { return "You're offline. Changes will send when you reconnect." }
		return "You're offline. \(queued) \(queued == 1 ? "change" : "changes") will send when you reconnect."
	}

	private func sectionLabel(entries: [FeedEntry]) -> some View {
		let needs = entries.filter { $0.bucket == .needs }.count
		return HStack {
			MonoLabel(needs > 0 ? "Decision needed · \(needs)" : "Catching up")
			Spacer()
		}
		.padding(.top, MaskinSpace.s3)
		.accessibilityAddTraits(.isHeader)
	}

	private var displayMenu: some View {
		Menu {
			Picker("View", selection: $store.options.mode) {
				Label("Cards", systemImage: "rectangle.grid.1x2").tag(ForYouDisplayOptions.Mode.cards)
				Label("List", systemImage: "list.bullet").tag(ForYouDisplayOptions.Mode.list)
			}
			Picker("Sort", selection: $store.options.sort) {
				Text("Most important").tag(ForYouDisplayOptions.Sort.attention)
				Text("Latest").tag(ForYouDisplayOptions.Sort.latest)
			}
			if !store.typeCounts.isEmpty {
				Picker("Show", selection: $store.options.typeFilter) {
					Text("Everything").tag(String?.none)
					ForEach(store.typeCounts, id: \.type) { item in
						Text("\(item.type.capitalized)s (\(item.count))").tag(String?.some(item.type))
					}
				}
			}
			Section {
				Button("Dismiss all FYIs", systemImage: "checkmark") {
					withAnimation(MaskinMotion.standard) { store.dismissAllFYIs() }
					MaskinHaptics.play(.success)
				}
				Button("Take every suggested option", systemImage: "sparkles") {
					withAnimation(MaskinMotion.standard) { store.takeSuggestedOptions() }
					MaskinHaptics.play(.success)
				}
			}
		} label: {
			Label("Display", systemImage: "line.3.horizontal.decrease")
		}
		.accessibilityLabel("Display options")
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
				ForEach(entries) { entry in
					card(entry)
						.modifier(ReadableRow(width: readableWidth))
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
						.contextMenu {
							if let open = openObject {
								Button("Open", systemImage: "arrow.up.right") { open(entry.id) }
							}
							if entry.record == nil {
								Button("Mark as read", systemImage: "checkmark") { dismiss(entry) }
							}
						}
				}
			}
		}
	}

	private func card(_ entry: FeedEntry) -> some View {
		let id = entry.id
		let isCards = store.options.mode == .cards
		var actions = DecisionCardView.Actions.live(store: store, entry: entry, openObject: openObject)
		if !isCards {
			actions.toggleExpanded = {
				withAnimation(MaskinMotion.standard) {
					if openIds.contains(id) { openIds.remove(id) } else { openIds.insert(id) }
				}
			}
		}
		return DecisionCardView(
			entry: entry, sender: store.senderName(of: entry.card),
			expanded: isCards || openIds.contains(id), now: fixedNow ?? Date(), actions: actions)
	}

	private func dismiss(_ entry: FeedEntry) {
		MaskinHaptics.play(.selection)
		withAnimation(MaskinMotion.standard) { store.dismiss(entry.card) }
	}
}

// MARK: - Pieces

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
