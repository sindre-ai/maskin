#if os(iOS)
	import MaskinCore
	import MaskinDesign
	import MaskinUI
	import SwiftUI

	/// Settings > Advanced > Native surfaces > Caller ID: whether the phone shows the names of the
	/// people Maskin holds when they ring, read from the phone's own answer. When it is off, the
	/// three steps that switch it on. iPhone only: a call screen has no web counterpart.
	struct CallerIDSection: View {
		let runtime: AppRuntime
		@State private var refreshing = false

		static let steps = [
			"Open the Settings app and tap Phone.",
			"Tap Call Blocking and Identification.",
			"Switch on Maskin.",
		]

		private var store: CallerIDStatusStore { runtime.callerIDStatus }

		var body: some View {
			Section {
				HStack {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Label("Caller ID", systemImage: "phone.arrow.down.left").foregroundStyle(MaskinColor.ink)
						Text(Self.summary(for: store.status, count: store.loadedCount))
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
					Spacer()
					Text(Self.statusTitle(store.status)).foregroundStyle(MaskinColor.ink4)
				}
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.accessibilityElement(children: .combine)
				.task { await store.refreshStatus() }
				if store.status != .enabled {
					ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
						NumberedStep(number: index + 1, text: step)
					}
				}
				Button {
					Task {
						refreshing = true
						await runtime.refreshCallerID(force: true)
						refreshing = false
					}
				} label: {
					HStack {
						Text("Refresh names")
						if refreshing { Spacer(); ProgressView() }
					}
				}
				.disabled(refreshing)
			} header: {
				Text("Caller ID")
			} footer: {
				Text(
					"Names and numbers come from your Maskin contacts and stay on this phone. Signing out removes them. Your own Contacts win over this list."
				)
			}
		}

		static func statusTitle(_ status: CallerIDStatus) -> String {
			switch status {
			case .enabled: "On"
			case .disabled: "Off"
			case .unknown: "Not known"
			}
		}

		static func summary(for status: CallerIDStatus, count: Int) -> String {
			switch status {
			case .enabled:
				count == 0 ? "On, but no names are loaded yet" : "\(count) \(count == 1 ? "number" : "numbers") loaded"
			case .disabled: "Show a contact's name when they call"
			case .unknown: "The phone has not said whether it is on"
			}
		}
	}
#endif
