#!/usr/bin/env python3
# @format
"""Validate the GitOps deployment surface before merge.

Three passes, mirroring what ArgoCD does at sync time so template/schema
errors fail the PR instead of the sync:

  1. helm lint every local chart (charts/*/chart).
  2. For every Application under argocd-apps/, re-render each in-repo Helm
     source with the exact valueFiles / values / valuesObject the Application
     declares, then schema-check the rendered manifests with kubeconform.
     Raw-manifest (directory) sources are schema-checked in place.
  3. Schema-check the Application/ApplicationSet manifests themselves.

Remote-chart sources (repoURL pointing at an external Helm registry) are
skipped — rendering them needs network fetches; their values are still
exercised indirectly because the Application manifest itself is validated.

Requires: helm, kubeconform, PyYAML. Exits non-zero on the first failing
pass, printing every failure in that pass.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
APPS_DIR = REPO_ROOT / "argocd-apps"
# Only the eks/ tree is synced by a root app; Application yamls in the
# argocd-apps/ root are kubeadm-era legacy (pending deletion) and are
# schema-checked but not rendered.
SYNCED_APPS_DIR = APPS_DIR / "eks"
CHARTS_DIR = REPO_ROOT / "charts"

# Sources whose repoURL matches one of these are "this repo" and can be
# rendered locally. HTTPS and SSH forms both appear historically.
SELF_REPO_MARKERS = (
    "github.com/Nelson-Lamounier/kubernetes-bootstrap",
    "github.com:Nelson-Lamounier/kubernetes-bootstrap",
)

# kubeconform: core schemas + community CRD catalog (Application,
# ApplicationSet, ExternalSecret, IngressRoute, Rollout, ...).
# -ignore-missing-schemas keeps niche CRDs from blocking the gate while
# everything with a published schema is still checked strictly.
KUBECONFORM_ARGS = [
    "kubeconform",
    "-strict",
    "-ignore-missing-schemas",
    "-schema-location",
    "default",
    "-schema-location",
    "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/"
    "{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json",
    "-summary",
]


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def fail(msgs: list[str], pass_name: str) -> None:
    print(f"\n✗ {pass_name}: {len(msgs)} failure(s)")
    for m in msgs:
        print(f"  - {m}")
    sys.exit(1)


def local_charts() -> list[Path]:
    return sorted(p.parent for p in CHARTS_DIR.glob("*/chart/Chart.yaml"))


def helm_lint_pass() -> None:
    failures = []
    for chart in local_charts():
        res = run(["helm", "lint", str(chart)])
        if res.returncode != 0:
            failures.append(f"{chart.relative_to(REPO_ROOT)}\n{res.stdout}{res.stderr}")
    if failures:
        fail(failures, "helm lint")
    print(f"✓ helm lint: {len(local_charts())} charts clean")


def app_docs(root: Path = APPS_DIR) -> list[tuple[Path, dict]]:
    docs = []
    for f in sorted(root.rglob("*.yaml")):
        try:
            for doc in yaml.safe_load_all(f.read_text()):
                if isinstance(doc, dict) and doc.get("kind") in (
                    "Application",
                    "ApplicationSet",
                ):
                    docs.append((f, doc))
        except yaml.YAMLError as e:
            fail([f"{f.relative_to(REPO_ROOT)}: YAML parse error: {e}"], "YAML parse")
    return docs


def kubeconform_check(manifest_text: str, label: str, failures: list[str]) -> None:
    res = run(KUBECONFORM_ARGS, input=manifest_text)
    if res.returncode != 0:
        failures.append(f"{label}\n{res.stdout}{res.stderr}")


def render_pass() -> None:
    failures = []
    rendered = 0
    for app_file, doc in app_docs(SYNCED_APPS_DIR):
        if doc["kind"] != "Application":
            continue  # ApplicationSets templated per-generator; schema pass covers them
        spec = doc.get("spec", {})
        sources = spec.get("sources") or ([spec["source"]] if spec.get("source") else [])
        for src in sources:
            repo_url = src.get("repoURL", "")
            path = src.get("path")
            if not path or not any(m in repo_url for m in SELF_REPO_MARKERS):
                continue
            src_dir = REPO_ROOT / path
            label = f"{app_file.relative_to(REPO_ROOT)} → {path}"
            if not src_dir.is_dir():
                failures.append(f"{label}: source path does not exist")
                continue
            helm = src.get("helm", {})
            if (src_dir / "Chart.yaml").exists():
                cmd = ["helm", "template", doc["metadata"]["name"], str(src_dir)]
                if helm.get("releaseName"):
                    cmd[2] = helm["releaseName"]
                ok = True
                for vf in helm.get("valueFiles", []):
                    vf_path = (src_dir / vf).resolve()
                    if not vf_path.exists():
                        failures.append(f"{label}: valueFiles entry missing: {vf}")
                        ok = False
                        continue
                    cmd += ["-f", str(vf_path)]
                if not ok:
                    continue
                with tempfile.TemporaryDirectory() as td:
                    for key in ("values", "valuesObject"):
                        if helm.get(key):
                            raw = (
                                helm[key]
                                if isinstance(helm[key], str)
                                else yaml.safe_dump(helm[key])
                            )
                            extra = Path(td) / f"{key}.yaml"
                            extra.write_text(raw)
                            cmd += ["-f", str(extra)]
                    res = run(cmd)
                if res.returncode != 0:
                    failures.append(f"{label}: helm template failed\n{res.stderr}")
                    continue
                kubeconform_check(res.stdout, f"{label} (rendered)", failures)
                rendered += 1
            else:
                # Raw manifest directory (e.g. gitops/arc, argocd-ingress).
                for mf in sorted(src_dir.rglob("*.yaml")):
                    kubeconform_check(
                        mf.read_text(), f"{label}/{mf.name}", failures
                    )
                rendered += 1
    if failures:
        fail(failures, "render + kubeconform")
    print(f"✓ render + kubeconform: {rendered} in-repo sources validated")


def app_schema_pass() -> None:
    failures = []
    count = 0
    for app_file, doc in app_docs():
        kubeconform_check(
            yaml.safe_dump(doc),
            str(app_file.relative_to(REPO_ROOT)),
            failures,
        )
        count += 1
    if failures:
        fail(failures, "Application schema")
    print(f"✓ Application schema: {count} Application/ApplicationSet docs valid")


if __name__ == "__main__":
    helm_lint_pass()
    render_pass()
    app_schema_pass()
    print("\nAll validation passes green.")
