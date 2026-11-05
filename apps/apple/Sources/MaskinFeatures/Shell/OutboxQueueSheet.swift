import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The offline banner's View: what is waiting to send, oldest first, and what could not be sent.
/// Writes go out in order when the connection returns; there is nothing to do here but look, or
/// dismiss a failure.
struct OutboxQueueSheet: View {
	let queue: OutboxQueue
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		let entries = queue.entries
		let failures = queue.failures
		NavigationStack {
			List {
				if !entries.isEmpty {
					Section {
						ForEach(entries) { entry in
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(entry.summary).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(2)
								Label("Waiting to send", systemImage: "clock")
									.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							}
							.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
							.accessibilityElement(children: .combine)
						}
					} footer: {
						Text("They send in order when the connection returns.")
					}
				}
				if !failures.isEmpty {
					Section("Could not send") {
						ForEach(failures) { failure in
							HStack(alignment: .top, spacing: MaskinSpace.s5) {
								VStack(alignment: .leading, spacing: MaskinSpace.s1) {
									Text(failure.summary).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(2)
									Text(failure.message).maskinText(.caption).foregroundStyle(MaskinColor.danger)
								}
								Spacer(minLength: MaskinSpace.s3)
								Button("Dismiss") { queue.dismissFailure(failure.id) }
									.maskinText(.subhead).fontWeight(.semibold)
									.buttonStyle(.plain)
									.frame(minHeight: MaskinSpace.touchMin)
							}
							.accessibilityElement(children: .combine)
						}
					}
				}
			}
			.overlay {
				if entries.isEmpty && failures.isEmpty {
					EmptyState(
						symbol: "checkmark.circle", title: "Nothing waiting",
						message: "Everything you did has been sent.")
				}
			}
			.scrollContentBackground(.hidden)
			.ambientBackground()
			.navigationTitle("Waiting to send")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}
}
