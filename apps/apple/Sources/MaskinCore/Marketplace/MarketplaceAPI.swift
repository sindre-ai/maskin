import Foundation

/// Marketplace endpoints for one workspace. A protocol so the store tests without a server.
public protocol MarketplaceAPI: Sendable {
	func catalog() async throws -> [MarketplaceLoop]
	func detail(loopID: String) async throws -> MarketplaceLoopDetail
	func installs() async throws -> [InstalledLoop]
	/// Installs the loop into the workspace; returns the install row.
	func install(loopID: String, idempotencyKey: String) async throws -> InstalledLoop
	/// Detaches the install from marketplace updates (keeps everything it provisioned).
	func fork(installID: String, idempotencyKey: String) async throws
	/// Removes the install; `keepProvisionedItems` leaves its agents, triggers and skills behind.
	func uninstall(installID: String, keepProvisionedItems: Bool, idempotencyKey: String)
		async throws
}
