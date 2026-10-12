import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The pages of an object's detail screen.
enum ObjectDetailPart: String, CaseIterable, Identifiable {
	/// Everything in one column (snapshots, previews).
	case all
	/// The pinned header above the pager.
	case header
	case overview, related, activity
	var id: String { rawValue }

	init(_ tab: ObjectDetailTab) {
		switch tab {
		case .overview: self = .overview
		case .related: self = .related
		case .activity: self = .activity
		}
	}

	/// The remembered tab this part stands for; `nil` for `.all` and `.header`.
	var tab: ObjectDetailTab? {
		switch self {
		case .overview: .overview
		case .related: .related
		case .activity: .activity
		case .all, .header: nil
		}
	}
}

/// The body of an object: header, then the Overview, Related and Activity pages. `part` picks
/// which of them to render, so the screen can pin the header and give each page its own scroll
/// view. Stateless apart from the store it reads, so it renders in snapshots; the screen adds the
/// toolbar, composer and navigation around it.
struct ObjectDetailContent<Decision: View>: View {
	let store: ObjectDetailStore
	var part: ObjectDetailPart = .all
	var onOpenObject: ((String) -> Void)?
	var onEdit: () -> Void = {}
	var onReply: ((TimelineItem) -> Void)?
	var onShowActivity: () -> Void = {}
	/// Pins "now" and opens the description (snapshots).
	var now: Date = Date()
	var descriptionExpanded = false
	/// False draws the header chips without their menus (snapshots).
	var interactiveChips = true
	@ViewBuilder var decision: () -> Decision

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			if part == .all || part == .header {
				if let message = store.actionError {
					FormError(message).onTapGesture { store.clearActionError() }
				}
				if store.isOffline { OfflineBanner() }
			}
			if let object = store.object {
				switch part {
				case .all:
					ObjectHeaderView(store: store, object: object, interactiveChips: interactiveChips)
					overview(object)
					ObjectRelatedView(store: store, onOpenObject: onOpenObject)
					ObjectActivityView(store: store, onOpenObject: onOpenObject, onReply: onReply, now: now)
				case .header: ObjectHeaderView(store: store, object: object, interactiveChips: interactiveChips)
				case .overview: overview(object)
				case .related: ObjectRelatedView(store: store, onOpenObject: onOpenObject)
				case .activity: ObjectActivityView(store: store, onOpenObject: onOpenObject, onReply: onReply, now: now)
				}
			} else if part == .all || part == .header {
				switch store.phase {
				case .gone:
					EmptyState(
						symbol: "trash", title: "This object was deleted",
						message: "It's no longer in the workspace.")
				case .failed(let message):
					EmptyState(
						symbol: "exclamationmark.triangle", title: "Couldn't load this object", message: message
					) {
						Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
					}
				default:
					LoadingSkeleton(rows: 2)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func overview(_ object: WorkObject) -> some View {
		ObjectOverviewView(
			store: store, object: object, descriptionExpanded: descriptionExpanded, onShowActivity: onShowActivity
		) { decision() }
	}
}

extension ObjectDetailContent where Decision == EmptyView {
	init(
		store: ObjectDetailStore, onOpenObject: ((String) -> Void)? = nil, onEdit: @escaping () -> Void = {}
	) {
		self.init(store: store, onOpenObject: onOpenObject, onEdit: onEdit) { EmptyView() }
	}
}
