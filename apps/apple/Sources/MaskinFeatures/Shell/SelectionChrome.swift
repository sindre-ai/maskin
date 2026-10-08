import MaskinCore
import MaskinDesign
import SwiftUI

/// The leading checkbox a row shows while a list is in selection mode. Ink, not a brand colour.
struct SelectionCheckbox: View {
	let isPicked: Bool

	var body: some View {
		Image(systemName: isPicked ? "checkmark.circle.fill" : "circle")
			.font(.title3)
			.foregroundStyle(isPicked ? MaskinColor.ink : MaskinColor.ink4)
			.accessibilityHidden(true)
	}
}

extension View {
	/// Marks the row as a selection-mode toggle for assistive tech.
	func selectionRowAccessibility(isActive: Bool, isPicked: Bool) -> some View {
		accessibilityAddTraits(isActive && isPicked ? .isSelected : [])
	}

	/// Selection mode's chrome (handoff 1A): the tab bar and nav bar step aside, glass pills Cancel
	/// and Select all float at the top over a "{n} selected" title, and a glass bar with the
	/// actions floats at the bottom.
	func selectionToolbar<Actions: View>(
		_ selection: SelectionModel, allIDs: [String], noun: String,
		@ViewBuilder actions: @escaping () -> Actions
	) -> some View {
		modifier(SelectionToolbar(selection: selection, allIDs: allIDs, noun: noun, actions: actions))
	}

	/// A transient "…  Undo" toast above the bottom edge. Setting `offer` shows it; it clears
	/// itself after a few seconds or when Undo is tapped.
	func undoToast(_ offer: Binding<UndoOffer?>) -> some View {
		modifier(UndoToastModifier(offer: offer))
	}
}

/// What an undo toast says and does. A new offer replaces the last one.
struct UndoOffer: Identifiable {
	let id = UUID()
	let message: String
	let undo: @MainActor () async -> Void
}

private struct UndoToastModifier: ViewModifier {
	@Binding var offer: UndoOffer?

	func body(content: Content) -> some View {
		content
			.safeAreaInset(edge: .bottom, spacing: 0) {
				if let offer {
					HStack(spacing: MaskinSpace.s6) {
						Text(offer.message)
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.ink)
							.lineLimit(2)
						Button("Undo") {
							let action = offer.undo
							self.offer = nil
							Task { await action() }
						}
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink)
						.frame(minHeight: MaskinSpace.touchMin)
					}
					.padding(.horizontal, MaskinSpace.s9)
					.maskinGlass(in: Capsule())
					.padding(.bottom, MaskinSpace.s4)
					.transition(.move(edge: .bottom).combined(with: .opacity))
					.accessibilityElement(children: .contain)
					.task(id: offer.id) {
						try? await Task.sleep(for: .seconds(6))
						if !Task.isCancelled, self.offer?.id == offer.id { self.offer = nil }
					}
				}
			}
			.animation(.snappy, value: offer?.id)
	}
}

#if os(iOS)
private struct HideTabBar: ViewModifier {
	let hidden: Bool

	func body(content: Content) -> some View {
		if #available(iOS 18.0, *) {
			content.toolbarVisibility(hidden ? .hidden : .automatic, for: .tabBar)
		} else {
			content
		}
	}
}
#endif

private struct SelectionToolbar<Actions: View>: ViewModifier {
	let selection: SelectionModel
	let allIDs: [String]
	let noun: String
	@ViewBuilder let actions: () -> Actions

	func body(content: Content) -> some View {
		#if os(iOS)
		content
			.toolbar(selection.isActive ? .hidden : .automatic, for: .navigationBar)
			.modifier(HideTabBar(hidden: selection.isActive))
			.safeAreaInset(edge: .top, spacing: 0) {
				if selection.isActive { topBar }
			}
			.safeAreaInset(edge: .bottom, spacing: 0) {
				if selection.isActive { bottomBar }
			}
		#else
		content
		#endif
	}

	private var topBar: some View {
		HStack(spacing: MaskinSpace.s5) {
			pill("Cancel") { selection.exit() }
			Spacer(minLength: MaskinSpace.s3)
			Text(Self.count(selection.count))
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.accessibilityAddTraits(.isHeader)
			Spacer(minLength: MaskinSpace.s3)
			pill("Select all") { selection.selectAll(allIDs) }
				.disabled(selection.isAllSelected(of: allIDs))
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s4)
		.transition(.move(edge: .top).combined(with: .opacity))
	}

	private func pill(_ title: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s8)
				.frame(minHeight: MaskinSpace.touchMin)
				.maskinGlass(in: Capsule(), interactive: true)
		}
		.buttonStyle(.plain)
	}

	private var bottomBar: some View {
		HStack(spacing: MaskinSpace.s4) {
			actions()
		}
		.tint(MaskinColor.ink)
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s3)
		.maskinGlass(in: Capsule())
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s4)
		.transition(.move(edge: .bottom).combined(with: .opacity))
	}

	/// "{n} selected"; before anything is picked it still reads as a count.
	static func count(_ n: Int) -> String { "\(n) selected" }
}

/// A bottom-bar action in the selection bar: a text label on the glass, the primary one filled.
struct SelectionBarLabel: View {
	let title: String
	var isPrimary = false
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		Text(title)
			.maskinText(.subhead).fontWeight(.semibold)
			.foregroundStyle(isPrimary ? MaskinSurface.onInverse : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(isPrimary ? MaskinSurface.inverse : Color.clear, in: Capsule())
			.opacity(isEnabled ? 1 : 0.4)
			.contentShape(Capsule())
	}
}
