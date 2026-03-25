"""SSM Parameter Store resolution helpers.

Generic resolver that maps SSM parameter names to environment variable
names. Supports environment variable overrides so that values can be
injected without SSM access (useful for local testing and CI).

Usage::

    from deploy_helpers.ssm import resolve_secrets

    SECRET_MAP = {
        "dynamodb-table-name": "DYNAMODB_TABLE_NAME",
        "auth/nextauth-secret": "NEXTAUTH_SECRET",
    }

    secrets = resolve_secrets(ssm_client, "/nextjs/development", SECRET_MAP)
"""

from __future__ import annotations

import os
from typing import Any

from deploy_helpers.logging import log_info, log_warn


def resolve_secrets(
    ssm_client: Any,
    ssm_prefix: str,
    secret_map: dict[str, str],
    *,
    client_error_cls: type[Exception] | None = None,
) -> dict[str, str]:
    """Fetch secrets from SSM Parameter Store.

    For each entry in ``secret_map``, checks for an environment variable
    override first. If no override exists, resolves the value from SSM
    using ``ssm_prefix/param_name``.

    Args:
        ssm_client: boto3 SSM client instance.
        ssm_prefix: SSM parameter path prefix (e.g. ``/nextjs/development``).
        secret_map: Mapping of ``ssm_param_suffix → env_var_name``.
        client_error_cls: The botocore ``ClientError`` class for exception
            handling. If None, all exceptions are caught generically.

    Returns:
        Dict of ``env_var_name → resolved_value`` for all found parameters.
    """
    secrets: dict[str, str] = {}

    for param_name, env_var in secret_map.items():
        # Check for environment override
        existing = os.getenv(env_var, "")
        if existing and existing != f"${{{env_var}}}" and existing != f"__{env_var}__":
            log_info("Using environment override", env_var=env_var)
            secrets[env_var] = existing
            continue

        ssm_path = f"{ssm_prefix}/{param_name}"
        log_info("Resolving from SSM", env_var=env_var, ssm_path=ssm_path)

        try:
            resp = ssm_client.get_parameter(Name=ssm_path, WithDecryption=True)
            value = resp["Parameter"]["Value"]
            secrets[env_var] = value
            log_info("Resolved from SSM", env_var=env_var)
        except Exception as exc:
            # Handle botocore ClientError specifically if the class is provided
            if client_error_cls and isinstance(exc, client_error_cls):
                code = exc.response["Error"]["Code"]
                if code == "ParameterNotFound":
                    log_warn("Not found in SSM", env_var=env_var, ssm_path=ssm_path)
                else:
                    log_warn("SSM error", env_var=env_var, error_code=code)
            else:
                log_warn("SSM resolution failed", env_var=env_var, error=str(exc))

    return secrets
