"""Conftest for ArgoCD tests — adds system/argocd to sys.path.

Since the global pythonpath no longer includes ``system/argocd``
(to avoid collision with boot/steps/helpers), this conftest
adds it per-suite.
"""
from __future__ import annotations

import sys
from pathlib import Path

_argocd = str(Path(__file__).resolve().parents[1] / "system" / "argocd")
if _argocd not in sys.path:
    sys.path.insert(0, _argocd)
