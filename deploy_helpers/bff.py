"""BFF (Backend-for-Frontend) service URL resolution.

Resolves the public base URLs for ``admin-api`` and ``public-api`` from AWS SSM
Parameter Store. Both parameters are seeded by ``KubernetesEdgeStack`` (CDK)
during infrastructure deployment.

SSM path convention (mirrors ``infra/lib/config/ssm-paths.ts → bedrockSsmPaths``):

.. code-block:: text

    /bedrock-{short_env}/admin-api-url  → ADMIN_API_URL
    /bedrock-{short_env}/public-api-url → PUBLIC_API_URL

In-cluster Kubernetes service DNS is used as a safe fallback when the SSM
parameter is absent (e.g. first deploy before the edge stack has executed).

All resolution goes through the shared ``resolve_secrets`` helper so the
logging, env-override, and error-handling path is **identical** across every
SSM lookup in the codebase — no raw ``ssm_client.get_parameter()`` calls here.

Usage::

    from deploy_helpers.bff import resolve_bff_urls

    bff = resolve_bff_urls(ssm_client, short_env="dev", client_error_cls=ClientError)
    secrets["ADMIN_API_URL"]  = bff.admin_api_url
    secrets["PUBLIC_API_URL"] = bff.public_api_url
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from deploy_helpers.logging import log_warn
from deploy_helpers.ssm import resolve_secrets

# ---------------------------------------------------------------------------
# In-cluster fallback DNS
#
# Used when the SSM parameter does not yet exist.  These are the Kubernetes
# Service DNS names (namespace.service:port) that resolve within the cluster.
# Production always has the real public URL in SSM, so fallbacks only apply
# during bootstrap or before the edge stack has run.
# ---------------------------------------------------------------------------

_FALLBACK_ADMIN_API: str = "http://admin-api.admin-api:3002"
_FALLBACK_PUBLIC_API: str = "http://public-api.public-api:3001"

# SSM suffix → env var name.  Suffix is appended to /bedrock-{short_env}/.
_BFF_SSM_MAP: dict[str, str] = {
    "admin-api-url": "ADMIN_API_URL",
    "public-api-url": "PUBLIC_API_URL",
}


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BffUrls:
    """Resolved BFF service base URLs.

    Attributes:
        admin_api_url: Base URL for the ``admin-api`` BFF service.
            Used by ``start-admin`` server functions.
        public_api_url: Base URL for the ``public-api`` BFF service.
            Used by the ``site`` (Next.js) resume proxy route.
    """

    admin_api_url: str
    public_api_url: str


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def resolve_bff_urls(
    ssm_client: Any,
    short_env: str,
    client_error_cls: type[Exception],
) -> BffUrls:
    """Resolve BFF service URLs from SSM Parameter Store.

    Reads ``/bedrock-{short_env}/admin-api-url`` and
    ``/bedrock-{short_env}/public-api-url`` via the shared ``resolve_secrets``
    helper, ensuring consistent logging and env-override behaviour.

    If either parameter is missing in SSM the corresponding in-cluster Kubernetes
    service DNS is used as a fallback so that deployments can proceed even before
    the edge stack has run.

    Args:
        ssm_client: A boto3 SSM client instance.
        short_env: Short environment name (e.g. ``"dev"``, ``"stg"``, ``"prd"``).
            Must match the prefix used by ``KubernetesEdgeStack`` when seeding
            the parameters.
        client_error_cls: The botocore ``ClientError`` class, passed through to
            ``resolve_secrets`` for structured error handling.

    Returns:
        A frozen :class:`BffUrls` dataclass with ``admin_api_url`` and
        ``public_api_url`` populated from SSM or the in-cluster fallback.
    """
    bedrock_prefix = f"/bedrock-{short_env}"

    resolved = resolve_secrets(
        ssm_client,
        bedrock_prefix,
        _BFF_SSM_MAP,
        client_error_cls=client_error_cls,
    )

    admin_api_url = resolved.get("ADMIN_API_URL", "")
    if not admin_api_url:
        log_warn(
            "ADMIN_API_URL not found in SSM — using in-cluster fallback",
            ssm_path=f"{bedrock_prefix}/admin-api-url",
            fallback=_FALLBACK_ADMIN_API,
        )
        admin_api_url = _FALLBACK_ADMIN_API

    public_api_url = resolved.get("PUBLIC_API_URL", "")
    if not public_api_url:
        log_warn(
            "PUBLIC_API_URL not found in SSM — using in-cluster fallback",
            ssm_path=f"{bedrock_prefix}/public-api-url",
            fallback=_FALLBACK_PUBLIC_API,
        )
        public_api_url = _FALLBACK_PUBLIC_API

    return BffUrls(admin_api_url=admin_api_url, public_api_url=public_api_url)
