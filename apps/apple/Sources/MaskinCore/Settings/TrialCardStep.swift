import Foundation

/// The card step for a workspace that signed up without a card. The card form is on the web
/// (`start-trial/<workspace>`); the phone sends the person there and shows the same notice the
/// web does while the trial has not started. There is no card form in the app.
public enum TrialCardStep {
	public static let notStartedMessage = "Your trial has not started. Add a card to begin your 7 days."
	public static let actionTitle = "Add card"

	/// The web card step for this workspace; nil if the id cannot make a path.
	public static func url(workspaceId: String, host: String = "maskin.io") -> URL? {
		var components = URLComponents()
		components.scheme = "https"
		components.host = host
		components.path = "/start-trial/\(workspaceId)"
		return components.url
	}
}
