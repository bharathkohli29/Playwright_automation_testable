import pytest
import subprocess
import sys
from pathlib import Path

def test_cli_help():
    cmd = [sys.executable, "cli.py", "--help"]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert "auto-validate" in res.stdout or "inspect" in res.stdout


def test_cli_inspect_command():
    live_path = Path("F:/ai-testable-platform")
    if not live_path.exists():
        pytest.skip("Live platform path not found")
        
    cmd = [sys.executable, "cli.py", "inspect", "--platform-path", str(live_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert "Platform Version:" in res.stdout
    assert "Discovered Tools" in res.stdout
    assert "Live Routes" in res.stdout


def test_cli_auto_validate_dry_run():
    live_path = Path("F:/ai-testable-platform")
    if not live_path.exists():
        pytest.skip("Live platform path not found")
        
    cmd = [
        sys.executable, "cli.py", "auto-validate",
        "--platform-path", str(live_path),
        "--issue-key", "TP-6246",
        "--dry-run"
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert "[OK]" in res.stdout or "SUCCESS" in res.stdout or "Validated" in res.stdout
    assert "TP-6246" in res.stdout
