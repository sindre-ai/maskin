import MaskinDesign
import MaskinUI
import SwiftUI
import UserNotifications
import WatchKit

/// What the long look shows: the alert's title (who is asking) and body (the message and its
/// question). The buttons under it come from the notification's category.
@MainActor
@Observable
final class DecisionLongLookModel {
	var title = ""
	var message = ""
}

struct DecisionLongLook: View {
	let model: DecisionLongLookModel

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
			if !model.title.isEmpty {
				Text(model.title).font(WatchType.name()).foregroundStyle(MaskinColor.ink).lineLimit(2)
			}
			Text(model.message).font(WatchType.body()).foregroundStyle(MaskinColor.ink)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// The decision alert's long look (5-Watch.md: message and question). Tapping the alert opens the
/// card through the app's normal notification handling.
final class DecisionNotificationController: WKUserNotificationHostingController<DecisionLongLook> {
	private let model = MainActor.assumeIsolated { DecisionLongLookModel() }

	override var body: DecisionLongLook { DecisionLongLook(model: model) }

	override func didReceive(_ notification: UNNotification) {
		let content = notification.request.content
		MainActor.assumeIsolated {
			model.title = content.title
			model.message = content.body
		}
	}
}
