"""Conftest for boot tests.

Boot tests import from ``boot_helpers.config`` which resolves
via the ``boot/steps`` entry in pyproject.toml pythonpath.
No additional sys.path manipulation is needed.
"""
