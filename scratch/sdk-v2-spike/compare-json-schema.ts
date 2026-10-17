import { createRequire } from 'node:module';
import fs from 'node:fs';
import { z } from 'zod';
import { tools } from '/agent/workspace/pin/packages/mcp/src/tools.ts';
import '/agent/workspace/pin/packages/mcp/src/extensions.ts';
import { getAllModules } from '@maskin/module-sdk';
const req = createRequire('/agent/workspace/spike/package.json');
const { zodToJsonSchema } = req('zod-to-json-schema');
const golden = JSON.parse(fs.readFileSync('/tmp/golden.json', 'utf8'));
const gtools: any[] = golden.tools ?? golden.result?.tools ?? golden;
const byName: Record<string, any> = {};
for (const [n, t] of Object.entries(tools as any)) byName[n] = (t as any).inputSchema;
for (const m of getAllModules() as any[]) for (const t of (m.tools ?? [])) byName[t.name ?? t.id] = t.inputSchema;
let same = 0, diff = 0, missing = 0; const diffs: string[] = [];
const canon = (o: any): any => Array.isArray(o) ? o.map(canon) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, canon(o[k])])) : o;
for (const g of gtools) {
	const s = byName[g.name];
	if (!s) { missing++; diffs.push(`${g.name}: no zod schema found by name`); continue; }
	// What the v1 SDK did for a raw shape: z.object(shape) then convert with strictUnions + pipeStrategy input.
	const schema = s instanceof z.ZodType ? s : z.object(s);
	const out = zodToJsonSchema(schema, { strictUnions: true, pipeStrategy: 'input' });
	const a = canon(out), b = canon(g.inputSchema);
	if (JSON.stringify(a) === JSON.stringify(b)) same++; else { diff++; diffs.push(`${g.name}: differs`); }
	// Also test the naive variant (only pipeStrategy) to show whether strictUnions matters
}
console.log({ total: gtools.length, same, diff, missing });
console.log(diffs.slice(0, 10).join('\n'));
{
	const g = gtools.find((x: any) => x.name === 'list_integration_providers');
	const s = byName['list_integration_providers'];
	const schema = s instanceof z.ZodType ? s : z.object(s);
	const out = zodToJsonSchema(schema, { strictUnions: true, pipeStrategy: 'input' });
	console.log('GOLDEN', JSON.stringify(canon(g.inputSchema)).slice(0, 700));
	console.log('OURS  ', JSON.stringify(canon(out)).slice(0, 700));
	// Also: what the naive spec-literal options (pipeStrategy only, $refStrategy none) give across all tools
	let naiveDiff = 0;
	for (const g2 of gtools) { const s2 = byName[g2.name]; const sc = s2 instanceof z.ZodType ? s2 : z.object(s2);
		const o2 = zodToJsonSchema(sc, { pipeStrategy: 'input', $refStrategy: 'none' }); if (JSON.stringify(canon(o2)) !== JSON.stringify(canon(g2.inputSchema))) naiveDiff++; }
	console.log('naive options (pipeStrategy input, refStrategy none, no strictUnions) differ on', naiveDiff, 'of', gtools.length);
}
