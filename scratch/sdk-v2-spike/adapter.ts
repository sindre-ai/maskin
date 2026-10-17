import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

// Prototype of toStandardSchema (spike only, not merged).
export function toStandardSchema<T extends ZodTypeAny>(schema: T) {
	const build = () => {
		const js = zodToJsonSchema(schema, { pipeStrategy: 'input', $refStrategy: 'none' }) as Record<string, unknown>;
		js.$schema = 'https://json-schema.org/draft/2020-12/schema';
		return js;
	};
	return {
		'~standard': {
			version: 1 as const,
			vendor: 'maskin-zod3-adapter',
			validate: (value: unknown) => (schema as any)['~standard'].validate(value),
			jsonSchema: { input: () => build(), output: () => build() },
		} as any,
	} as { '~standard': any } & { __t?: T };
}
