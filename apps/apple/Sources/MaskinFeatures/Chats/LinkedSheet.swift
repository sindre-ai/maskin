import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Everything the conversation links to, newest first: the place to work through the drafts an
/// agent has written (read, approve), look at its pages and open the objects it mentions. Each
/// item says who linked it and when, with a way back to that message.
struct LinkedSheet: View {
	let entries: [LinkedEntry]
	let onJump: (LinkedEntry) -> Void
	/// A draft was approved from here: the entry it came from, its title and the approved text.
	let onApproved: (LinkedEntry, _ title: String?, _ body: String) -> Void

	@Environment(\.linkedItems) private var store
	@Environment(\.dismiss) private var dismiss
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		NavigationStack {
			Group {
				if entries.isEmpty {
					EmptyState(
						symbol: "link", title: "Nothing linked yet",
						message: "Drafts, pages and objects that messages in this chat link to will appear here.")
				} else {
					ScrollView {
						LazyVStack(alignment: .leading, spacing: MaskinSpace.s9) {
							ForEach(entries) { entry in
								row(entry)
							}
						}
						.padding(.horizontal, MaskinSpace.s9)
						.padding(.vertical, MaskinSpace.s6)
					}
				}
			}
			.background(MaskinSurface.grouped)
			.navigationTitle("Linked")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
		// The shell presents an object or a file from above everything, and cannot while this sheet
		// is up: close it first.
		.environment(\.linkedOpen, { target in openAfterClosing(target) })
	}

	private func openAfterClosing(_ target: LinkedTarget) {
		LinkedOpener.openAfterClosing(target, close: { dismiss() }, runtime: runtime)
	}

	private func row(_ entry: LinkedEntry) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s4) {
				Group {
					Text("from \(entry.actorName)")
					if let date = entry.date { Text("·"); RelativeTime(date) }
				}
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
				Spacer(minLength: 0)
				Button("Jump to message") {
					dismiss()
					onJump(entry)
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin)
				.buttonStyle(.maskinPressed)
			}
			card(entry)
		}
		.accessibilityElement(children: .contain)
		// Rows are lazy, so a long list asks about what is on screen, not all hundred at once.
		.task(id: entry.target.key) { await store?.resolveWithRetries([entry.target]) }
	}

	@ViewBuilder
	private func card(_ entry: LinkedEntry) -> some View {
		switch store?.state(for: entry.target) {
		case .ready(.plain(let reference))?:
			LinkedPlainRow(
				target: reference.target, title: reference.title, kindLabel: reference.kindLabel,
				symbol: reference.target.kind == .file ? "doc" : "doc.text")
		case .ready?:
			LinkedTargetCard(target: entry.target, onApproved: { title, body in onApproved(entry, title, body) })
		case .unavailable?:
			// Missing, in another workspace, or not reachable now: still a way to try it.
			LinkedPlainRow(
				target: entry.target, title: entry.target.kind == .file ? "Linked file" : "Linked object",
				kindLabel: "Couldn't show a preview", symbol: entry.target.kind == .file ? "doc" : "doc.text")
		case .loading?, nil:
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.fill(MaskinSurface.fill)
				.frame(height: MaskinSpace.s14 + MaskinSpace.s14)
				.accessibilityLabel("Loading")
		}
	}
}
