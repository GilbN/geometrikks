"""docs/configuration.md must match the settings classes (generated file)."""
import subprocess
import sys


def test_configuration_docs_are_fresh():
    result = subprocess.run(
        [sys.executable, "scripts/generate_config_docs.py", "--check"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
