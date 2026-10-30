"""Keep the Apple certificate cap from filling up across TestFlight runs.

Xcode's automatic signing on a fresh runner can create a development certificate on every
archive. This script records the development certificates that exist before the archive
(snapshot) and revokes only the ones that appeared during the run (revoke-new).

  asc_dev_certs.py snapshot FILE     write the ids of existing development certificates
  asc_dev_certs.py revoke-new FILE   revoke development certificates not listed in FILE

Reads ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 from the environment. Distribution
certificates and anything that existed before the run are never touched. If FILE is missing,
revoke-new does nothing. Needs pyjwt and cryptography.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt

DEVELOPMENT = {"IOS_DEVELOPMENT", "DEVELOPMENT", "MAC_APP_DEVELOPMENT"}
BASE = "https://api.appstoreconnect.apple.com"


def call(method, url):
    now = int(time.time())
    token = jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        os.environ["ASC_KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"Apple returned HTTP {e.code} on {method} {url}: {e.read().decode()[:500]}")


def development_ids():
    url = f"{BASE}/v1/certificates?limit=200&fields%5Bcertificates%5D=certificateType"
    ids = set()
    while url:
        page = call("GET", url)
        ids.update(c["id"] for c in page.get("data", []) if c["attributes"].get("certificateType") in DEVELOPMENT)
        url = page.get("links", {}).get("next")
    return ids


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("snapshot", "revoke-new"):
        sys.exit(__doc__)
    command, path = sys.argv[1], sys.argv[2]
    if command == "snapshot":
        ids = development_ids()
        with open(path, "w") as f:
            json.dump(sorted(ids), f)
        print(f"Recorded {len(ids)} existing development certificates.")
        return
    if not os.path.exists(path):
        print("No snapshot, so nothing is revoked.")
        return
    with open(path) as f:
        before = set(json.load(f))
    new = sorted(development_ids() - before)
    for cert_id in new:
        call("DELETE", f"{BASE}/v1/certificates/{cert_id}")
        print("Revoked run-created development certificate", cert_id)
    print(f"Revoked {len(new)} development certificates created by this run.")


main()
