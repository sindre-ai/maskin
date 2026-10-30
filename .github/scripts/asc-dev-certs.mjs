// Keeps the Apple certificate allowance from filling up.
//
// ios-testflight.yml runs on a fresh Mac, and Xcode's automatic signing mints a new development
// certificate on every run. Apple stops issuing profiles once the account holds its maximum.
//
//   node asc-dev-certs.mjs snapshot <file>   write the ids of today's development certificates
//   node asc-dev-certs.mjs revoke-new <file> revoke development certificates not in <file>
//
// Only development types are ever listed for revocation. Distribution certificates and profiles
// are never touched. Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH. Nothing secret is printed.

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_PATH } = process.env;
const [command, file] = process.argv.slice(2);
const API = 'https://api.appstoreconnect.apple.com';
const DEV_TYPES = new Set(['DEVELOPMENT', 'IOS_DEVELOPMENT', 'MAC_APP_DEVELOPMENT']);

if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8_PATH || !file || !['snapshot', 'revoke-new'].includes(command)) {
  console.error('Usage: ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_KEY_P8_PATH=... node asc-dev-certs.mjs <snapshot|revoke-new> <file>');
  process.exit(1);
}

const b64url = (v) => Buffer.from(v).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const signingInput =
  b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })) + '.' +
  b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
const signature = sign('sha256', Buffer.from(signingInput), {
  key: createPrivateKey(readFileSync(ASC_KEY_P8_PATH, 'utf8')),
  dsaEncoding: 'ieee-p1363',
});
const token = signingInput + '.' + b64url(signature);

async function asc(method, path) {
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function listDevCertIds() {
  const ids = [];
  let path = '/v1/certificates?limit=200&fields[certificates]=certificateType';
  while (path) {
    const page = await asc('GET', path);
    for (const c of page.data) if (DEV_TYPES.has(c.attributes.certificateType)) ids.push(c.id);
    path = page.links && page.links.next ? page.links.next.replace(API, '') : null;
  }
  return ids;
}

const current = await listDevCertIds();

if (command === 'snapshot') {
  writeFileSync(file, JSON.stringify(current));
  console.log(`Development certificates before this run: ${current.length}.`);
} else {
  const before = new Set(JSON.parse(readFileSync(file, 'utf8')));
  const created = current.filter((id) => !before.has(id));
  console.log(`Development certificates now: ${current.length}. Created by this run: ${created.length}.`);
  for (const id of created) {
    await asc('DELETE', `/v1/certificates/${id}`);
    console.log(`Revoked development certificate ${id}.`);
  }
  console.log(`Development certificates after clean-up: ${current.length - created.length}.`);
}
