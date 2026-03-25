"""Kubernetes namespace and secret helpers.

Provides lazy-loading of the ``kubernetes`` Python client and
idempotent upsert operations for namespaces and secrets.

The ``kubernetes`` library is imported lazily so that ``--dry-run``
works on developer machines without the package installed.

Usage::

    from deploy_helpers.k8s import load_k8s, ensure_namespace, upsert_secret

    v1 = load_k8s("/etc/kubernetes/admin.conf")
    ensure_namespace(v1, "nextjs-app")
    upsert_secret(v1, "nextjs-secrets", "nextjs-app", {"KEY": "value"})
"""

from __future__ import annotations

import base64
import os
from typing import Any

from deploy_helpers.logging import log_info, log_warn

# Lazy-loaded references
_k8s_client: Any = None
_k8s_config: Any = None


def load_k8s(kubeconfig: str) -> Any:
    """Load the Kubernetes Python client and return a CoreV1Api instance.

    Imports the ``kubernetes`` library lazily and loads the kubeconfig
    from the specified path.

    Args:
        kubeconfig: Path to the kubeconfig file.

    Returns:
        A ``kubernetes.client.CoreV1Api`` instance.
    """
    global _k8s_client, _k8s_config

    from kubernetes import client as k8s_client_mod
    from kubernetes import config as k8s_config_mod

    _k8s_client = k8s_client_mod
    _k8s_config = k8s_config_mod

    os.environ["KUBECONFIG"] = kubeconfig
    _k8s_config.load_kube_config(config_file=kubeconfig)

    log_info("Kubernetes client loaded", kubeconfig=kubeconfig)
    return _k8s_client.CoreV1Api()


def ensure_namespace(v1: Any, namespace: str) -> None:
    """Create the Kubernetes namespace if it does not already exist.

    Idempotent: no-op if the namespace already exists.

    Args:
        v1: A ``CoreV1Api`` instance.
        namespace: Target namespace name.
    """
    try:
        v1.read_namespace(name=namespace)
    except _k8s_client.ApiException as exc:
        if exc.status == 404:
            v1.create_namespace(
                body=_k8s_client.V1Namespace(
                    metadata=_k8s_client.V1ObjectMeta(name=namespace),
                ),
            )
            log_info("Namespace created", namespace=namespace)
        else:
            raise


def upsert_secret(
    v1: Any,
    name: str,
    namespace: str,
    data: dict[str, str],
) -> None:
    """Create or replace a Kubernetes Opaque Secret.

    Uses an idempotent upsert pattern: attempts ``create``, and on
    ``409 Conflict`` falls back to ``replace``.

    Args:
        v1: A ``CoreV1Api`` instance.
        name: Secret name.
        namespace: Target namespace.
        data: Plain-text key-value pairs (base64-encoded automatically).
    """
    encoded = {
        k: base64.b64encode(v.encode()).decode()
        for k, v in data.items()
    }
    secret = _k8s_client.V1Secret(
        metadata=_k8s_client.V1ObjectMeta(name=name, namespace=namespace),
        type="Opaque",
        data=encoded,
    )
    try:
        v1.create_namespaced_secret(namespace=namespace, body=secret)
        log_info("Secret created", name=name, namespace=namespace, keys=len(data))
    except _k8s_client.ApiException as exc:
        if exc.status == 409:
            v1.replace_namespaced_secret(
                name=name, namespace=namespace, body=secret,
            )
            log_info("Secret replaced", name=name, namespace=namespace, keys=len(data))
        else:
            raise
