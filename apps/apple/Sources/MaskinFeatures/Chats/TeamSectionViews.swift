import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// The pieces of the sectioned Chats list (bet: Chat list sections): the three view tiles, the open
// view's header, a section's header, the quiet note and footer, and the Move to section sheet. They
// take plain values; `ConversationListView` owns the store calls.

/// The three views as tiles above the list. The number shows before anything is opened. Each tile is
/// a toggle: pressing the open one goes back to the whole list.
struct TeamViewTiles: View {
	@Binding var active: TeamView?
	/// A tile's number and whether more than one page exists ("40+"); nil while it loads.
	let counts: @MainActor (TeamView) -> (count: Int, more: Bool)?

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			ForEach(TeamView.allCases, id: \.self) { view in tile(view) }
		}
	}

	private func tile(_ view: TeamView) -> some View {
		let pressed = active == view
		let count = counts(view)
		let number = count.map { $0.more ? "\($0.count)+" : "\($0.count)" } ?? "–"
		return Button {
			MaskinHaptics.play(.selection)
			active = pressed ? nil : view
		} label: {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HStack(spacing: MaskinSpace.s3) {
					if view == .running, (count?.count ?? 0) > 0 {
						Circle().fill(MaskinColor.sig).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					}
					Text(number)
						.font(MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2))
						.monospacedDigit()
						.foregroundStyle(view == .waiting && (count?.count ?? 0) > 0 ? MaskinColor.sig : MaskinColor.ink)
				}
				Text(view.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
			}
			.padding(MaskinSpace.s6)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s10, alignment: .topLeading)
			.background(pressed ? MaskinSurface.card : MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous))
			.overlay {
				if pressed {
					RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous)
						.strokeBorder(MaskinColor.ink, lineWidth: MaskinSpace.s1 * 0.75)
				}
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(count.map { "\(view.label), \($0.count)\($0.more ? " or more" : "")" } ?? view.label)
		.accessibilityAddTraits(pressed ? .isSelected : [])
	}
}

/// The top of an open view: the way back, the title with its count, the one-line intro and, in Waiting
/// on you, Mark mentions read.
struct TeamViewHeader: View {
	let view: TeamView
	let count: Int
	let onBack: () -> Void
	var onMarkMentionsRead: (() -> Void)?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Button(action: onBack) {
				Label("Back to all chats", systemImage: "chevron.left")
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.sigInk)
					.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s12, alignment: .leading)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Text(view.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: .bold, relativeTo: .title3))
					.foregroundStyle(MaskinColor.ink)
				Text("\(count)").maskinText(.subhead).monospacedDigit().foregroundStyle(MaskinColor.inkPlaceholder)
				Spacer(minLength: 0)
				if let onMarkMentionsRead {
					Button("Mark mentions read", action: onMarkMentionsRead)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.sigInk)
				}
			}
			.accessibilityAddTraits(.isHeader)
			Text(view.intro).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
		}
	}
}

/// A section's header: the chevron and name fold it, the number is what waits on you inside it,
/// and the menu renames, moves or deletes it.
struct CustomSectionHeader: View {
	let section: TeamLayout.Section
	let canMoveUp: Bool
	let canMoveDown: Bool
	let onToggle: () -> Void
	let onRename: () -> Void
	let onMoveUp: () -> Void
	let onMoveDown: () -> Void
	let onDelete: () -> Void

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s4) {
			Button(action: onToggle) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
						.rotationEffect(.degrees(section.collapsed ? 0 : 90))
					Text(section.label)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Text("\(section.count)").maskinText(.subhead).monospacedDigit().foregroundStyle(MaskinColor.inkPlaceholder)
					if section.badge > 0 { UnreadBadge(count: section.badge) }
					Spacer(minLength: 0)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityElement(children: .combine)
			.accessibilityLabel("\(section.label), \(section.count) \(section.count == 1 ? "chat" : "chats")\(section.badge > 0 ? ", \(section.badge) waiting on you" : "")")
			.accessibilityValue(section.collapsed ? "Collapsed" : "Expanded")
			.accessibilityHint(section.collapsed ? "Opens the section" : "Folds the section")
			Menu {
				Button("Rename", systemImage: "pencil", action: onRename)
				if canMoveUp { Button("Move up", systemImage: "arrow.up", action: onMoveUp) }
				if canMoveDown { Button("Move down", systemImage: "arrow.down", action: onMoveDown) }
				Button("Delete section", systemImage: "trash", role: .destructive, action: onDelete)
			} label: {
				Image(systemName: "ellipsis")
					.maskinSymbol(MaskinFontSize.t15, weight: .semibold)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin - MaskinSpace.s4)
					.contentShape(Rectangle())
			}
			.accessibilityLabel("Section options for \(section.label)")
			.padding(.trailing, -MaskinSpace.s7)
		}
		.textCase(nil)
		.padding(.top, MaskinSpace.s12)
	}
}

/// The inside of an empty section: where it can take chats from.
struct EmptySectionRow: View {
	let name: String
	let onAdd: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text("No chats in \(name) yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Text("Add chats, or swipe a chat and choose Move.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Button("Add chats", action: onAdd).buttonStyle(.secondaryAction)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// The one note on the first view after release: chats left the list, and where they went.
struct QuietNote: View {
	let count: Int
	let onView: () -> Void
	let onDismiss: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text("\(TeamViewRules.quietChats(count)) left your list")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
			Text("No message for \(TeamViewRules.quietDays) days. Nothing is deleted. They are in Quiet and come back when someone writes. Pin a chat or put it in a section to keep it here.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			HStack(spacing: MaskinSpace.s5) {
				Button("View Quiet", action: onView).buttonStyle(InkPillButtonStyle())
				Button("Got it", action: onDismiss).buttonStyle(.secondaryAction)
			}
		}
		.padding(MaskinSpace.s6)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// The dashed line at the bottom of the list, so a chat leaving is never a silent disappearance.
struct QuietFooter: View {
	let count: Int
	let onView: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Text("\(TeamViewRules.quietChats(count)) \(count == 1 ? "is" : "are") in Quiet")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: 0)
			Button("View", action: onView)
				.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.sigInk)
		}
		.padding(.horizontal, MaskinSpace.s6)
		.frame(minHeight: MaskinSpace.touchMin)
		.overlay {
			RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous)
				.strokeBorder(MaskinSurface.line, style: StrokeStyle(lineWidth: MaskinSpace.s1 / 2, dash: [4, 3]))
		}
	}
}

/// "Quiet since 9 Nov. Send a message and it returns to your list." above a quiet chat opened from
/// search or the Quiet view. Same bar pattern as Archived.
struct QuietBar: View {
	let since: String

	var body: some View {
		Label("Quiet since \(since). Send a message and it returns to your list.", systemImage: "moon")
			.maskinText(.subhead)
			.foregroundStyle(MaskinColor.ink4)
			.padding(.horizontal, MaskinSpace.s6)
			.padding(.vertical, MaskinSpace.s4)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous))
			.padding(.horizontal, MaskinSpace.s6)
			.accessibilityElement(children: .combine)
	}
}

/// The name field for a new or renamed section. A taken name is refused with the same words as web.
struct SectionNameSheet: View {
	let title: String
	let confirmLabel: String
	let sections: [ChatSection]
	/// The section being renamed: its own name is not a duplicate of itself.
	var renaming: String?
	let onConfirm: (String) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var name: String
	@FocusState private var focused: Bool

	init(
		title: String, confirmLabel: String, sections: [ChatSection], renaming: ChatSection? = nil,
		onConfirm: @escaping (String) -> Void
	) {
		self.title = title
		self.confirmLabel = confirmLabel
		self.sections = sections
		self.renaming = renaming?.id
		self.onConfirm = onConfirm
		_name = State(initialValue: renaming?.name ?? "")
	}

	private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	private var isDuplicate: Bool { TeamViewRules.hasSection(named: trimmed, in: sections, excluding: renaming) }
	private var canConfirm: Bool { !trimmed.isEmpty && !isDuplicate && trimmed.count <= 60 }

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("Section name", text: $name)
						.focused($focused)
						.submitLabel(.done)
						.onSubmit(confirm)
						.autocorrectionDisabled()
				} footer: {
					if isDuplicate {
						Text(TeamViewRules.duplicateMessage(trimmed)).foregroundStyle(MaskinColor.danger)
					}
				}
			}
			.navigationTitle(title)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button(confirmLabel, action: confirm).disabled(!canConfirm)
				}
			}
			.onAppear { focused = true }
		}
		.presentationDetents([.height(240)])
	}

	private func confirm() {
		guard canConfirm else { return }
		onConfirm(trimmed)
		dismiss()
	}
}

/// Long-press, Move to section: the person's sections, Remove from the current one, and New section...
struct MoveToSectionSheet: View {
	let chatTitle: String
	let sections: [ChatSection]
	let currentSectionID: String?
	let onPick: (String?) -> Void
	let onNewSection: () -> Void
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			List {
				if let current = sections.first(where: { $0.id == currentSectionID }) {
					Button {
						onPick(nil)
						dismiss()
					} label: {
						Label("Remove from \(current.name)", systemImage: "minus.circle")
					}
				}
				Section {
					ForEach(sections) { section in
						Button {
							onPick(section.id)
							dismiss()
						} label: {
							HStack {
								Text(section.name).foregroundStyle(MaskinColor.ink)
								Spacer()
								if section.id == currentSectionID {
									Image(systemName: "checkmark").foregroundStyle(MaskinColor.sigInk)
								}
							}
						}
						.accessibilityAddTraits(section.id == currentSectionID ? .isSelected : [])
					}
					Button {
						dismiss()
						onNewSection()
					} label: {
						Label("New section...", systemImage: "plus")
					}
				}
			}
			.navigationTitle("Move to section")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
		}
		.presentationDetents([.medium, .large])
	}
}

/// "Add chats" on an empty section: pick chats, add them all at once.
struct AddChatsSheet: View {
	let sectionName: String
	let candidates: [ConversationSummary]
	let currentActorID: String?
	let onAdd: ([String]) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var picked: Set<String> = []

	var body: some View {
		NavigationStack {
			List {
				if candidates.isEmpty {
					Text("Every chat is already in a section.").foregroundStyle(MaskinColor.ink4)
				} else {
					Section("Pick chats to add") {
						ForEach(candidates) { chat in
							Button {
								if picked.contains(chat.id) { picked.remove(chat.id) } else { picked.insert(chat.id) }
							} label: {
								HStack(spacing: MaskinSpace.s6) {
									Image(systemName: picked.contains(chat.id) ? "checkmark.circle.fill" : "circle")
										.foregroundStyle(picked.contains(chat.id) ? MaskinColor.sigInk : MaskinColor.ink5)
									Text(TeamLayout.displayedTitle(of: .conversation(chat), me: currentActorID))
										.foregroundStyle(MaskinColor.ink)
										.lineLimit(1)
									Spacer(minLength: 0)
								}
								.contentShape(Rectangle())
							}
							.accessibilityAddTraits(picked.contains(chat.id) ? .isSelected : [])
						}
					}
				}
			}
			.navigationTitle("Add chats to \(sectionName)")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button(picked.isEmpty ? "Add" : "Add \(picked.count) \(picked.count == 1 ? "chat" : "chats")") {
						onAdd(candidates.map(\.id).filter(picked.contains))
						dismiss()
					}
					.disabled(picked.isEmpty)
				}
			}
		}
		.presentationDetents([.large])
	}
}
