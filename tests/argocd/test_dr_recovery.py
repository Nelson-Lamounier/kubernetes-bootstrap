"""Unit tests for ArgoCD DR recovery and self-healing token fixes.

Tests cover:
  - preserve_argocd_secret() — SSM fallback when in-cluster secret is absent
  - apply_ingress() — extended CRD wait timeout and post-apply verification
  - restore_argocd_secret() — post-patch verification and rollout wait
  - generate_ci_token() — retry with backoff and pre-store validation
"""
from __future__ import annotations

import subprocess
from unittest.mock import MagicMock, patch

import pytest

from helpers.config import Config
from steps.namespace import preserve_argocd_secret
from steps.networking import apply_ingress


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture()
def cfg(tmp_path: object) -> Config:
    """Create a Config with a temporary directory as argocd_dir."""
    return Config(
        ssm_prefix="/k8s/development",
        aws_region="eu-west-1",
        dry_run=False,
        kubeconfig="/tmp/kubeconfig",
    )


@pytest.fixture()
def cfg_with_manifests(tmp_path: object, cfg: Config) -> Config:
    """Create a Config with ingress manifests present on disk."""
    import tempfile
    from pathlib import Path

    argocd_dir = Path(tempfile.mkdtemp())
    (argocd_dir / "ingress.yaml").write_text("apiVersion: traefik.io/v1alpha1\nkind: IngressRoute\n")
    (argocd_dir / "webhook-ingress.yaml").write_text("apiVersion: traefik.io/v1alpha1\nkind: IngressRoute\n")

    return Config(
        ssm_prefix=cfg.ssm_prefix,
        aws_region=cfg.aws_region,
        dry_run=cfg.dry_run,
        kubeconfig=cfg.kubeconfig,
        argocd_dir=str(argocd_dir),
    )


# ══════════════════════════════════════════════════════════════════════════
# preserve_argocd_secret() — SSM fallback chain
# ══════════════════════════════════════════════════════════════════════════


class TestPreserveArgocdSecretInCluster:
    """When in-cluster argocd-secret exists, return the key directly."""

    @patch("steps.namespace.subprocess.run")
    def test_returns_key_from_cluster(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should return the signing key from kubectl get secret."""
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="c2VjcmV0LWtleQ==", stderr="",
        )

        result = preserve_argocd_secret(cfg)

        assert result == "c2VjcmV0LWtleQ=="

    @patch("steps.namespace.subprocess.run")
    def test_does_not_call_ssm_when_cluster_key_exists(
        self, mock_run: MagicMock, cfg: Config,
    ) -> None:
        """Should NOT attempt SSM fallback when cluster key is available."""
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="aW4tY2x1c3Rlci1rZXk=", stderr="",
        )

        with patch("steps.namespace.get_ssm_client") as mock_ssm:
            preserve_argocd_secret(cfg)
            mock_ssm.assert_not_called()


class TestPreserveArgocdSecretSsmFallback:
    """When in-cluster secret is absent (DR), fall back to SSM."""

    @patch("steps.namespace.get_ssm_client")
    @patch("steps.namespace.subprocess.run")
    def test_recovers_key_from_ssm_on_dr(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, cfg: Config,
    ) -> None:
        """Should recover signing key from SSM when cluster secret doesn't exist."""
        # kubectl returns empty (fresh cluster)
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="not found",
        )

        # SSM has the backed-up key
        mock_ssm = MagicMock()
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "c3NtLWJhY2t1cC1rZXk="},
        }

        result = preserve_argocd_secret(cfg)

        assert result == "c3NtLWJhY2t1cC1rZXk="
        mock_ssm.get_parameter.assert_called_once_with(
            Name="/k8s/development/argocd/server-secret-key",
            WithDecryption=True,
        )

    @patch("steps.namespace.get_ssm_client")
    @patch("steps.namespace.subprocess.run")
    def test_returns_none_when_both_sources_unavailable(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, cfg: Config,
    ) -> None:
        """Should return None on first-ever install (no cluster, no SSM)."""
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="not found",
        )

        mock_ssm = MagicMock()
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.side_effect = Exception("ParameterNotFound")

        result = preserve_argocd_secret(cfg)

        assert result is None

    @patch("steps.namespace.get_ssm_client")
    @patch("steps.namespace.subprocess.run")
    def test_ssm_fallback_uses_correct_path(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock,
    ) -> None:
        """Should use {ssm_prefix}/argocd/server-secret-key as the SSM path."""
        cfg = Config(ssm_prefix="/k8s/staging")

        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="", stderr="",
        )

        mock_ssm = MagicMock()
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "c3RhZ2luZy1rZXk="},
        }

        preserve_argocd_secret(cfg)

        mock_ssm.get_parameter.assert_called_once_with(
            Name="/k8s/staging/argocd/server-secret-key",
            WithDecryption=True,
        )


class TestPreserveArgocdSecretDryRun:
    """Dry-run mode should not attempt any external calls."""

    def test_dry_run_returns_none(self) -> None:
        """Should return None without calling kubectl or SSM."""
        cfg = Config(dry_run=True)

        with patch("steps.namespace.subprocess.run") as mock_run:
            with patch("steps.namespace.get_ssm_client") as mock_ssm:
                result = preserve_argocd_secret(cfg)

        assert result is None
        mock_run.assert_not_called()
        mock_ssm.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════
# apply_ingress() — Extended CRD wait and post-apply verification
# ══════════════════════════════════════════════════════════════════════════


class TestApplyIngressCrdWait:
    """The CRD wait should use the extended 300s (60 × 5s) timeout."""

    @patch("steps.networking.time.sleep")
    @patch("steps.networking.run")
    @patch("steps.networking.subprocess.run")
    def test_crd_wait_uses_extended_timeout(
        self,
        mock_subprocess: MagicMock,
        mock_run: MagicMock,
        mock_sleep: MagicMock,
        cfg_with_manifests: Config,
    ) -> None:
        """Should poll up to 60 times (300s) before giving up."""
        # ArgoCD pods running
        argocd_check = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="pod/argocd-server-xxx\n", stderr="",
        )
        # CRD never found
        crd_check = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="not found",
        )
        mock_subprocess.side_effect = [argocd_check] + [crd_check] * 60

        apply_ingress(cfg_with_manifests)

        # Should have slept 59 times (not on the last attempt)
        assert mock_sleep.call_count == 59

    @patch("steps.networking.time.sleep")
    @patch("steps.networking.run")
    @patch("steps.networking.subprocess.run")
    def test_crd_found_early_stops_polling(
        self,
        mock_subprocess: MagicMock,
        mock_run: MagicMock,
        mock_sleep: MagicMock,
        cfg_with_manifests: Config,
    ) -> None:
        """Should stop polling as soon as CRD is found."""
        argocd_check = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="pod/argocd-server-xxx\n", stderr="",
        )
        # CRD not found twice, then found
        crd_not_found = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="not found",
        )
        crd_found = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="ingressroutes.traefik.io\n", stderr="",
        )
        # After CRD found: kubectl apply returns success × 2, then verify returns success
        apply_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        verify_ok = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="ingressroute.traefik.io/argocd-ingress\n", stderr="",
        )

        mock_subprocess.side_effect = [
            argocd_check,    # ArgoCD pods check
            crd_not_found,   # CRD attempt 1
            crd_not_found,   # CRD attempt 2
            crd_found,       # CRD attempt 3 — found!
            verify_ok,       # Post-apply verification
        ]
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="", stderr="",
        )

        apply_ingress(cfg_with_manifests)

        # Only 2 sleeps (attempts 1 and 2 — attempt 3 found the CRD)
        assert mock_sleep.call_count == 2


class TestApplyIngressNoArgoCdPods:
    """When no ArgoCD pods are running, should skip the CRD wait."""

    @patch("steps.networking.run")
    @patch("steps.networking.subprocess.run")
    def test_skips_when_no_argocd_pods(
        self,
        mock_subprocess: MagicMock,
        mock_run: MagicMock,
        cfg_with_manifests: Config,
    ) -> None:
        """Should skip ingress entirely if no ArgoCD pods are Running."""
        mock_subprocess.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="", stderr="",
        )

        apply_ingress(cfg_with_manifests)

        # Should not call kubectl apply
        mock_run.assert_not_called()


class TestApplyIngressDryRun:
    """Dry-run should not apply anything."""

    def test_dry_run_skips_all(self) -> None:
        """Should return immediately without any kubectl calls."""
        cfg = Config(dry_run=True)

        with patch("steps.networking.subprocess.run") as mock_sub:
            with patch("steps.networking.run") as mock_run:
                apply_ingress(cfg)

        mock_sub.assert_not_called()
        mock_run.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════
# restore_argocd_secret() — Post-patch verification and rollout wait
# ══════════════════════════════════════════════════════════════════════════


from steps.install import restore_argocd_secret


class TestRestoreArgocdSecretVerification:
    """Post-patch verification: read back key and confirm match."""

    @patch("steps.install.subprocess.run")
    def test_success_when_key_matches(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should succeed when read-back key matches the patched key."""
        signing_key = "dGVzdC1rZXk="

        # patch → success, verify → matches, restart → ok, rollout → ok
        mock_run.side_effect = [
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # patch
            subprocess.CompletedProcess(args=[], returncode=0, stdout=signing_key, stderr=""),  # verify
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # restart
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # rollout
        ]

        restore_argocd_secret(cfg, signing_key)

        assert mock_run.call_count == 4

    @patch("steps.install.subprocess.run")
    def test_fails_when_key_mismatch(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should abort when read-back key does not match."""
        signing_key = "dGVzdC1rZXk="
        wrong_key = "d3Jvbmcta2V5"

        # patch → success, verify → mismatch
        mock_run.side_effect = [
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # patch
            subprocess.CompletedProcess(args=[], returncode=0, stdout=wrong_key, stderr=""),  # verify → mismatch
        ]

        restore_argocd_secret(cfg, signing_key)

        # Should NOT restart since verification failed
        assert mock_run.call_count == 2

    @patch("steps.install.subprocess.run")
    def test_fails_when_patch_fails(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should abort without verification when patch returns non-zero."""
        mock_run.return_value = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="error patching",
        )

        restore_argocd_secret(cfg, "dGVzdC1rZXk=")

        # Only 1 call (the patch), no verification or restart
        assert mock_run.call_count == 1


class TestRestoreArgocdSecretRolloutWait:
    """Rollout wait: blocks until argocd-server is ready."""

    @patch("steps.install.subprocess.run")
    def test_waits_for_rollout_completion(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should call rollout status with timeout after restart."""
        signing_key = "dGVzdC1rZXk="

        mock_run.side_effect = [
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # patch
            subprocess.CompletedProcess(args=[], returncode=0, stdout=signing_key, stderr=""),  # verify
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # restart
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # rollout status
        ]

        restore_argocd_secret(cfg, signing_key)

        # Verify the 4th call is rollout status with timeout
        rollout_call = mock_run.call_args_list[3]
        cmd = rollout_call[0][0] if rollout_call[0] else rollout_call[1].get("args", [])
        assert "rollout" in cmd
        assert "status" in cmd

    @patch("steps.install.subprocess.run")
    def test_continues_when_rollout_times_out(self, mock_run: MagicMock, cfg: Config) -> None:
        """Should log warning but not crash when rollout times out."""
        signing_key = "dGVzdC1rZXk="

        mock_run.side_effect = [
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # patch
            subprocess.CompletedProcess(args=[], returncode=0, stdout=signing_key, stderr=""),  # verify
            subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),       # restart
            subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="timed out"),  # rollout timeout
        ]

        # Should not raise
        restore_argocd_secret(cfg, signing_key)
        assert mock_run.call_count == 4

    def test_dry_run_skips_all(self) -> None:
        """Should return immediately without any kubectl calls."""
        cfg = Config(dry_run=True)

        with patch("steps.install.subprocess.run") as mock_run:
            restore_argocd_secret(cfg, "dGVzdC1rZXk=")

        mock_run.assert_not_called()

    def test_none_key_returns_early(self, cfg: Config) -> None:
        """Should return immediately when signing_key is None."""
        with patch("steps.install.subprocess.run") as mock_run:
            restore_argocd_secret(cfg, None)

        mock_run.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════
# generate_ci_token() — Retry with backoff and validation
# ══════════════════════════════════════════════════════════════════════════


from steps.auth import generate_ci_token


class TestGenerateCiTokenRetry:
    """Retry logic: 3 attempts with backoff."""

    @patch("steps.auth.time.sleep")
    @patch("steps.auth.subprocess.run")
    @patch("steps.auth.get_secrets_client")
    @patch("steps.auth.run")
    @patch("steps.auth._resolve_admin_password")
    def test_retries_on_login_failure(
        self,
        mock_admin: MagicMock,
        mock_run: MagicMock,
        mock_sm: MagicMock,
        mock_subprocess: MagicMock,
        mock_sleep: MagicMock,
        cfg: Config,
    ) -> None:
        """Should retry login when first attempt fails."""
        mock_admin.return_value = "admin-password"

        # Login fails twice, then succeeds; token generation succeeds
        login_fail = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="error")
        login_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        token_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="test-jwt-token", stderr="")

        mock_run.side_effect = [login_fail, login_ok, token_ok]

        # Validation curl → HTTP 200
        mock_subprocess.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="200", stderr="",
        )

        # Secrets Manager mock
        sm_mock = MagicMock()
        mock_sm.return_value = sm_mock

        generate_ci_token(cfg)

        # Should have slept once (after first failure)
        assert mock_sleep.call_count == 1

    @patch("steps.auth.time.sleep")
    @patch("steps.auth.subprocess.run")
    @patch("steps.auth.run")
    @patch("steps.auth._resolve_admin_password")
    def test_gives_up_after_all_attempts(
        self,
        mock_admin: MagicMock,
        mock_run: MagicMock,
        mock_subprocess: MagicMock,
        mock_sleep: MagicMock,
        cfg: Config,
    ) -> None:
        """Should give up after 3 failed login attempts."""
        mock_admin.return_value = "admin-password"

        # All login attempts fail
        login_fail = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="error")
        mock_run.return_value = login_fail

        generate_ci_token(cfg)

        # 3 login attempts, 2 sleeps (no sleep after last failure)
        assert mock_run.call_count == 3
        assert mock_sleep.call_count == 2


class TestGenerateCiTokenValidation:
    """Token is validated against ArgoCD API before storing."""

    @patch("steps.auth.time.sleep")
    @patch("steps.auth.subprocess.run")
    @patch("steps.auth.get_secrets_client")
    @patch("steps.auth.run")
    @patch("steps.auth._resolve_admin_password")
    def test_stores_token_on_200(
        self,
        mock_admin: MagicMock,
        mock_run: MagicMock,
        mock_sm: MagicMock,
        mock_subprocess: MagicMock,
        mock_sleep: MagicMock,
        cfg: Config,
    ) -> None:
        """Should store token when validation returns HTTP 200."""
        mock_admin.return_value = "admin-password"

        login_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        token_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="valid-jwt-token", stderr="")
        mock_run.side_effect = [login_ok, token_ok]

        # curl validation → 200
        mock_subprocess.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="200", stderr="",
        )

        sm_mock = MagicMock()
        mock_sm.return_value = sm_mock

        generate_ci_token(cfg)

        # Should have attempted to create or update secret
        assert sm_mock.create_secret.called or sm_mock.update_secret.called

    @patch("steps.auth.time.sleep")
    @patch("steps.auth.subprocess.run")
    @patch("steps.auth.get_secrets_client")
    @patch("steps.auth.run")
    @patch("steps.auth._resolve_admin_password")
    def test_does_not_store_on_401(
        self,
        mock_admin: MagicMock,
        mock_run: MagicMock,
        mock_sm: MagicMock,
        mock_subprocess: MagicMock,
        mock_sleep: MagicMock,
        cfg: Config,
    ) -> None:
        """Should NOT store token when validation returns HTTP 401."""
        mock_admin.return_value = "admin-password"

        login_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        token_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="bad-jwt-token", stderr="")
        mock_run.side_effect = [login_ok, token_ok]

        # curl validation → 401
        mock_subprocess.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="401", stderr="",
        )

        sm_mock = MagicMock()
        mock_sm.return_value = sm_mock

        generate_ci_token(cfg)

        # Should NOT have tried to store anything
        sm_mock.create_secret.assert_not_called()
        sm_mock.update_secret.assert_not_called()

    def test_dry_run_skips_generation(self) -> None:
        """Should return immediately in dry-run mode."""
        cfg = Config(dry_run=True)

        with patch("steps.auth.run") as mock_run:
            with patch("steps.auth._resolve_admin_password") as mock_admin:
                generate_ci_token(cfg)

        mock_admin.assert_not_called()
        mock_run.assert_not_called()

