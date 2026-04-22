"""Shared deployment framework for K8s secret deployment scripts.

Provides reusable modules for SSM → K8s Secret workflows:
- ``config``  — Base configuration dataclass
- ``logging`` — JSON structured logging (CloudWatch-friendly)
- ``runner``  — Subprocess execution with structured logging
- ``ssm``     — SSM Parameter Store resolution (generic key→env-var mapping)
- ``bff``     — BFF service URL resolution (admin-api-url, public-api-url)
- ``k8s``     — Kubernetes namespace and secret helpers
- ``s3``      — S3 sync wrapper

Used by:
- ``workloads/charts/nextjs/deploy.py``
- ``workloads/charts/start-admin/deploy.py``
- ``workloads/charts/public-api/deploy.py``
- ``workloads/charts/admin-api/deploy.py``
- ``platform/charts/monitoring/deploy.py``
"""
