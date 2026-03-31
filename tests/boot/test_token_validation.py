"""Unit tests for the kubeadm token validation utility.

Tests the ``validate_kubeadm_token`` function from ``common.py``
against various corruption patterns observed in production,
including backslash injection from SSM SecureString retrieval.
"""
from __future__ import annotations

import pytest

from common import validate_kubeadm_token


# ── Valid token samples ────────────────────────────────────────────────────

VALID_TOKEN = "ku8rm0.abc1234567890123"
VALID_TOKEN_ALT = "abcdef.0123456789abcdef"


class TestValidateKubeadmToken:
    """Tests for validate_kubeadm_token()."""

    # ── Clean / valid inputs ──────────────────────────────────────────

    def test_clean_token_passes_through(self) -> None:
        """A correctly formatted token should be returned unchanged."""
        result = validate_kubeadm_token(VALID_TOKEN, source="test")
        assert result == VALID_TOKEN

    def test_alternate_valid_token(self) -> None:
        """Verify another valid token pattern passes."""
        result = validate_kubeadm_token(VALID_TOKEN_ALT, source="test")
        assert result == VALID_TOKEN_ALT

    # ── Leading backslash sanitisation ────────────────────────────────

    def test_single_leading_backslash_stripped(self) -> None:
        """SSM SecureString commonly prepends a single backslash."""
        corrupted = f"\\{VALID_TOKEN}"
        result = validate_kubeadm_token(corrupted, source="SSM")
        assert result == VALID_TOKEN

    def test_multiple_leading_backslashes_stripped(self) -> None:
        """Edge case: multiple leading backslashes should all be removed."""
        corrupted = f"\\\\\\{VALID_TOKEN}"
        result = validate_kubeadm_token(corrupted, source="SSM")
        assert result == VALID_TOKEN

    # ── Whitespace sanitisation ───────────────────────────────────────

    def test_trailing_newline_stripped(self) -> None:
        """Shell output often includes trailing newlines."""
        result = validate_kubeadm_token(f"{VALID_TOKEN}\n", source="test")
        assert result == VALID_TOKEN

    def test_leading_and_trailing_whitespace_stripped(self) -> None:
        """Mixed whitespace should be cleaned."""
        result = validate_kubeadm_token(f"  {VALID_TOKEN}  ", source="test")
        assert result == VALID_TOKEN

    def test_combined_backslash_and_whitespace(self) -> None:
        """Both backslash corruption and whitespace should be handled."""
        corrupted = f"  \\{VALID_TOKEN}\n"
        result = validate_kubeadm_token(corrupted, source="test")
        assert result == VALID_TOKEN

    # ── Invalid tokens — should raise ValueError ─────────────────────

    def test_empty_string_raises(self) -> None:
        """An empty token is never valid."""
        with pytest.raises(ValueError, match="Empty kubeadm join token"):
            validate_kubeadm_token("", source="test")

    def test_whitespace_only_raises(self) -> None:
        """Whitespace-only input is effectively empty."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("   \n\t  ", source="test")

    def test_too_short_raises(self) -> None:
        """Token with too few characters after the dot."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("ab1234.short", source="test")

    def test_missing_dot_raises(self) -> None:
        """Token without a dot separator."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("abcdef0123456789012345", source="test")

    def test_uppercase_chars_raise(self) -> None:
        """kubeadm tokens are lowercase only."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("ABCDEF.0123456789abcdef", source="test")

    def test_special_chars_raise(self) -> None:
        """No special characters allowed."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("abc!ef.0123456789abcdef", source="test")

    def test_backslash_in_middle_raises(self) -> None:
        """Backslashes in the middle of the token are not fixable."""
        with pytest.raises(ValueError, match="Invalid kubeadm join token"):
            validate_kubeadm_token("abc\\ef.0123456789abcdef", source="test")

    # ── Source label in error messages ────────────────────────────────

    def test_source_label_in_error(self) -> None:
        """The 'source' parameter should appear in the error message."""
        with pytest.raises(ValueError, match="SSM Parameter Store"):
            validate_kubeadm_token("bad-token", source="SSM Parameter Store")
