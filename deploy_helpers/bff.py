"""BFF (Backend-for-Frontend) service URL resolution.

Resolves the public base URLs for ``admin-api`` and ``public-api`` from AWS SSM
Parameter Store. Both parameters are seeded by ``KubernetesEdgeStack`` (CDK)
during infrastructure deployment.

SSM path convention (mirrors ``infra/lib/config/ssm-paths.ts → bedrockSsmPaths``):

.. code-block:: text

    /bedrock-{short_env}/admin-api-url  → ADMIN_API_URL
    /bedrock-{short_env}/public-api-url → PUBLIC_API_URL

.. note::

    ``KubernetesEdgeStack`` is **always deployed to ``us-east-1``** (CloudFront
    WAF requirement).  These SSM parameters therefore live in ``us-east-1`` even
    though the Kubernetes cluster runs in ``eu-west-1``.  :func:`resolve_bff_urls`
    creates its own cross-region ``boto3`` SSM client for ``us-east-1`` internally
    so callers do **not** need to know about this detail.

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

import boto3
from dataclasses import dataclass
from typing import Any

from deploy_helpers.logging import log_warn
from deploy_helpers.ssm import resolve_secrets

# ---------------------------------------------------------------------------
# Edge Stack region
#
# KubernetesEdgeStack is ALWAYS deployed to us-east-1 because CloudFront WAF
# associations require a us-east-1 stack.  All /bedrock-*/admin-api-url and
# /bedrock-*/public-api-url parameters therefore live in us-east-1.
# ---------------------------------------------------------------------------

_EDGE_REGION: str = "us-east-1"

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
# Internal factory (module-level so unit tests can patch it)
# ---------------------------------------------------------------------------


def _make_edge_ssm_client() -> Any:
    """Create a boto3 SSM client targeting the Edge Stack region (us-east-1).

    Extracted as a module-level function so tests can patch it without needing
    real AWS credentials.

    Returns:
        A boto3 SSM client configured for ``_EDGE_REGION``.
    """
    return boto3.client("ssm", region_name=_EDGE_REGION)


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

    .. important::

        These parameters are seeded by ``KubernetesEdgeStack`` (CDK), which is
        **always deployed to ``us-east-1``** because CloudFront WAF associations
        require a us-east-1 stack.  The calling ``deploy.py`` scripts run with
        an ``eu-west-1`` SSM client (the primary cluster region) so this
        function creates a dedicated cross-region client via
        :func:`_make_edge_ssm_client` rather than burdening every caller with
        the region detail.

        The ``us-east-1`` region is fixed.  If you ever move the edge stack to
        another region, update ``_EDGE_REGION`` at the top of this module.

    If either parameter is missing in SSM the corresponding in-cluster Kubernetes
    service DNS is used as a fallback so that deployments can proceed even before
    the edge stack has run.

    Args:
        ssm_client: A boto3 SSM client instance (used for the primary region
            — **not** used for BFF URL resolution, which always reads from
            ``us-east-1`` via :func:`_make_edge_ssm_client`).
        short_env: Short environment name (e.g. ``"dev"``, ``"stg"``, ``"prd"``).
            Must match the prefix used by ``KubernetesEdgeStack`` when seeding
            the parameters.
        client_error_cls: The botocore ``ClientError`` class, passed through to
            ``resolve_secrets`` for structured error handling.

    Returns:
        A frozen :class:`BffUrls` dataclass with ``admin_api_url`` and
        ``public_api_url`` populated from SSM or the in-cluster fallback.
    """
    edge_ssm_client = _make_edge_ssm_client()
    bedrock_prefix = f"/bedrock-{short_env}"

    resolved = resolve_secrets(
        edge_ssm_client,
        bedrock_prefix,
        _BFF_SSM_MAP,
        client_error_cls=client_error_cls,
    )

    admin_api_url = resolved.get("ADMIN_API_URL", "")
    if not admin_api_url:
        log_warn(
            "ADMIN_API_URL not found in SSM — using in-cluster fallback",
            ssm_path=f"{bedrock_prefix}/admin-api-url",
            region=_EDGE_REGION,
            fallback=_FALLBACK_ADMIN_API,
        )
        admin_api_url = _FALLBACK_ADMIN_API

    public_api_url = resolved.get("PUBLIC_API_URL", "")
    if not public_api_url:
        log_warn(
            "PUBLIC_API_URL not found in SSM — using in-cluster fallback",
            ssm_path=f"{bedrock_prefix}/public-api-url",
            region=_EDGE_REGION,
            fallback=_FALLBACK_PUBLIC_API,
        )
        public_api_url = _FALLBACK_PUBLIC_API

    return BffUrls(admin_api_url=admin_api_url, public_api_url=public_api_url)
