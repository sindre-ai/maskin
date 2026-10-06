import Foundation
import MaskinAPI

/// Translates between `WorkspaceSchema` and the wire shapes. The generated names stay in here.
enum SettingsSchemaWire {
	typealias Body = Operations.patch_sol_api_sol_workspaces_sol__lcub_id_rcub_.Input.Body.jsonPayload
	typealias Settings = Body.settingsPayload

	// MARK: Reading

	private struct RawSettings: Decodable {
		struct Field: Decodable {
			var name: String
			var type: String
			var required: Bool?
			var values: [String]?
		}
		var field_definitions: [String: [Field]]?
		var statuses: [String: [String]]?
		var display_names: [String: String]?
	}

	/// Tolerant: a missing, null or malformed settings blob yields an empty schema rather than
	/// failing the screen. Unknown property kinds are skipped, never rewritten.
	static func decode(settingsJSON: Data) -> WorkspaceSchema {
		guard let raw = try? JSONDecoder().decode(RawSettings.self, from: settingsJSON) else {
			return WorkspaceSchema()
		}
		var definitions: [String: [PropertyDefinition]] = [:]
		for (type, fields) in raw.field_definitions ?? [:] {
			definitions[type] = fields.compactMap { field in
				guard let kind = PropertyDefinition.Kind(rawValue: field.type) else { return nil }
				return PropertyDefinition(
					name: field.name, kind: kind, isRequired: field.required ?? false,
					values: field.values ?? [])
			}
		}
		return WorkspaceSchema(
			fieldDefinitions: definitions, statuses: raw.statuses ?? [:],
			displayNames: raw.display_names ?? [:])
	}

	// MARK: Writing

	static func patchBody(_ schema: WorkspaceSchema, keys: Set<WorkspaceSchema.Key>) -> Body {
		var settings = Settings()
		if keys.contains(.fieldDefinitions) {
			var map: [String: [Settings.field_definitionsPayload.additionalPropertiesPayloadPayload]] = [:]
			for (type, props) in schema.fieldDefinitions {
				map[type] = props.compactMap { prop in
					guard
						let kind = Settings.field_definitionsPayload.additionalPropertiesPayloadPayload
							._typePayload(rawValue: prop.kind.rawValue)
					else { return nil }
					return .init(
						name: prop.name, _type: kind, required: prop.isRequired,
						values: prop.kind == .enum ? prop.values : nil)
				}
			}
			settings.field_definitions = .init(additionalProperties: map)
		}
		if keys.contains(.statuses) {
			settings.statuses = .init(additionalProperties: schema.statuses)
		}
		if keys.contains(.displayNames) {
			settings.display_names = .init(additionalProperties: schema.displayNames)
		}
		return Body(settings: settings)
	}
}
