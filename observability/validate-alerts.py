#!/usr/bin/env python3
"""Validate the Grafana alert-rule files under observability/*/alerts/.

WHY THIS EXISTS RATHER THAN `promtool check rules`.

These files are Grafana UNIFIED ALERTING files (`apiVersion: 1`, groups of
rules carrying `data[].model.expr`, `noDataState`, `execErrState`). promtool
validates the PROMETHEUS rule format (`groups[].rules[].expr` alongside
`alert:`/`record:`), which is a different schema — pointed at these files it
rejects them wholesale and tells you nothing about the PromQL inside.

So this script does the part that actually matters: it digs the PromQL out of
each rule's `data[].model.expr`, substitutes the `${...}` deployment
placeholders for syntactically valid stand-ins, and feeds the result to
promtool as a synthetic Prometheus rules file. That catches a malformed query
in an alert rule, which is otherwise undetectable until the alert fails to fire
during the incident it was written for.

It also asserts the structural invariants that YAML syntax alone will not
catch, and that have each already been wrong at least once in this directory:

  * `condition` names a refId that actually exists in `data`
  * every `__expr__` node's `expression` names an existing refId
  * template bodies use `$values.<refId>.Value`, never the bare `$value`
    (in Grafana `$value` is the ValueString — a string like
    "[ var='x' labels={} value=0.18 ]" — so `humanizePercentage $value`
    renders garbage; this is fixable only by knowing the refId)
  * uids are unique across every file, since a collision silently overwrites
    on import
  * `${...}` placeholders appearing in the body are documented in the header

Run locally with:  python observability/validate-alerts.py
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERT_GLOB = os.path.join(REPO_ROOT, "observability", "*", "alerts", "*.yaml")

PLACEHOLDER_RE = re.compile(r"\$\{([A-Z0-9_]+)\}")

# Stand-ins used only to make a placeholder-bearing expr parseable. They never
# reach a real Grafana — the point is to check the PromQL AROUND them.
PLACEHOLDER_STUBS = {
    "PROM_DATASOURCE_UID": "stub_datasource_uid",
    "CONTACT_POINT": "stub_contact_point",
    "SEAWEEDFS_PROM_JOB_LABEL": "stub_job",
    "COLLECTOR_PROM_JOB_LABEL": "stub_job",
}

errors: list[str] = []
seen_uids: dict[str, str] = {}


def fail(where: str, message: str) -> None:
    errors.append(f"{where}: {message}")


def substitute(expr: str) -> str:
    """Replace ${VAR} with a syntactically valid stand-in."""

    def sub(match: re.Match[str]) -> str:
        return PLACEHOLDER_STUBS.get(match.group(1), "stub_value")

    return PLACEHOLDER_RE.sub(sub, expr)


def check_file(path: str) -> list[str]:
    """Validate one alert file. Returns the PromQL exprs found in it."""
    rel = os.path.relpath(path, REPO_ROOT)
    raw = open(path, encoding="utf-8").read()
    header = "\n".join(ln for ln in raw.split("\n") if ln.startswith("#"))

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        fail(rel, f"not valid YAML: {exc}")
        return []

    if not isinstance(doc, dict) or "groups" not in doc:
        fail(rel, "missing top-level `groups:` — is this a file-provisioning file?")
        return []

    exprs: list[str] = []

    for group in doc["groups"]:
        gname = group.get("name", "<unnamed>")
        if not group.get("interval"):
            fail(rel, f"group {gname}: no `interval`")

        for rule in group.get("rules", []):
            uid = rule.get("uid")
            title = rule.get("title", "<untitled>")
            where = f"{rel}: {uid or title}"

            if not uid:
                fail(where, "rule has no `uid` — imports cannot be made idempotent")
            elif uid in seen_uids:
                fail(where, f"duplicate uid, already used in {seen_uids[uid]}")
            else:
                seen_uids[uid] = rel

            ref_ids = {node.get("refId") for node in rule.get("data", [])}

            # `condition` must name a node that exists, or Grafana imports the
            # rule and it never evaluates.
            condition = rule.get("condition")
            if condition not in ref_ids:
                fail(
                    where,
                    f"condition `{condition}` is not a refId in data ({sorted(ref_ids)})",
                )

            query_ref_ids = []
            for node in rule.get("data", []):
                model = node.get("model", {})
                if node.get("datasourceUid") == "__expr__":
                    target = model.get("expression")
                    if target not in ref_ids:
                        fail(
                            where,
                            f"expression node references `{target}`, "
                            f"not a refId in data ({sorted(ref_ids)})",
                        )
                elif model.get("expr"):
                    exprs.append(substitute(model["expr"]))
                    query_ref_ids.append(node.get("refId"))

            # The $value trap. In Grafana alerting $value is the ValueString,
            # not a float, so any numeric formatter applied to it emits
            # garbage. The fix requires naming the query refId explicitly.
            for key, body in (rule.get("annotations") or {}).items():
                if not isinstance(body, str):
                    continue
                if re.search(r"\$value\b", body):
                    hint = query_ref_ids[0] if query_ref_ids else "<refId>"
                    fail(
                        where,
                        f"annotation `{key}` uses bare `$value`; "
                        f"use `$values.{hint}.Value` (in Grafana alerting "
                        f"$value is the ValueString, not a number)",
                    )

            for state_key in ("noDataState", "execErrState"):
                if not rule.get(state_key):
                    fail(where, f"no `{state_key}` — the default may not be what you want")

    # Every placeholder used in the body should be explained in the header,
    # otherwise whoever imports this cannot know what to substitute.
    body = "\n".join(ln for ln in raw.split("\n") if not ln.startswith("#"))
    for name in sorted(set(PLACEHOLDER_RE.findall(body))):
        if name not in header:
            fail(rel, f"placeholder ${{{name}}} is used but not documented in the header")

    return exprs


def check_promql(exprs: list[str]) -> None:
    """Feed the extracted PromQL to promtool as a synthetic rules file."""
    if not exprs:
        return

    promtool = shutil.which("promtool")
    if not promtool:
        print("promtool not on PATH — skipping PromQL syntax check", file=sys.stderr)
        print("  (CI installs it; locally: apt-get install prometheus, or skip)", file=sys.stderr)
        return

    rules = {
        "groups": [
            {
                "name": "extracted",
                "rules": [
                    {"alert": f"Extracted{i}", "expr": expr}
                    for i, expr in enumerate(exprs)
                ],
            }
        ]
    }

    with tempfile.NamedTemporaryFile(
        "w", suffix=".yaml", delete=False, encoding="utf-8"
    ) as handle:
        yaml.safe_dump(rules, handle)
        tmp = handle.name

    try:
        result = subprocess.run(
            [promtool, "check", "rules", tmp],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            fail(
                "promql",
                "promtool rejected an extracted expression:\n"
                + (result.stdout or "")
                + (result.stderr or ""),
            )
        else:
            print(f"promtool: {len(exprs)} extracted expression(s) parse cleanly")
    finally:
        os.unlink(tmp)


def main() -> int:
    paths = sorted(glob.glob(ALERT_GLOB))
    if not paths:
        print(f"no alert files matched {ALERT_GLOB}", file=sys.stderr)
        return 1

    all_exprs: list[str] = []
    for path in paths:
        print(f"checking {os.path.relpath(path, REPO_ROOT)}")
        all_exprs.extend(check_file(path))

    check_promql(all_exprs)

    if errors:
        print("\nFAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(f"\nOK: {len(paths)} file(s), {len(seen_uids)} rule(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
