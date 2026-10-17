import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z, ZodTypeAny } from 'zod';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

// Typed variant of the prototype: output type flows from the Zod 3 schema.
export function toStandardSchemaTyped<T extends ZodTypeAny>(schema: T): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
	const build = () => {
		const js = zodToJsonSchema(schema, { pipeStrategy: 'input', $refStrategy: 'none' }) as Record<string, unknown>;
		js.$schema = 'https://json-schema.org/draft/2020-12/schema';
		return js;
	};
	return {
		'~standard': {
			version: 1,
			vendor: 'maskin-zod3-adapter',
			validate: (value: unknown) => (schema as any)['~standard'].validate(value),
			jsonSchema: { input: () => build(), output: () => build() },
		},
	} as StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
