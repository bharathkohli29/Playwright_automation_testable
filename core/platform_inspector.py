import logging
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional
from core.config import DEFAULT_PLATFORM_PATH

log = logging.getLogger(__name__)

class PlatformInspector:
    """Read-only inspector for the Testable platform codebase."""
    
    def __init__(self, platform_path: Path | str = DEFAULT_PLATFORM_PATH):
        self.root = Path(platform_path).resolve()

    def is_valid_platform_root(self) -> bool:
        if not self.root.exists() or not self.root.is_dir():
            return False
        required_dirs = ["frontend", "backend", "shared", "tools"]
        return all((self.root / d).is_dir() for d in required_dirs)

    def get_version(self) -> str:
        version_file = self.root / "VERSION"
        if version_file.exists():
            try:
                return version_file.read_text(encoding="utf-8").strip()
            except Exception as exc:
                log.warning("could not read %s: %s", version_file, exc)
        return "unknown"

    def get_git_commit(self, short: bool = True) -> str:
        if not (self.root / ".git").exists():
            return "no-git"
        try:
            cmd = ["git", "-C", str(self.root), "rev-parse", "--short" if short else "", "HEAD"]
            cmd = [c for c in cmd if c]
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return res.stdout.strip()
        except Exception as exc:
            log.warning("git rev-parse failed in %s: %s", self.root, exc)
            return "unknown-commit"

    def get_git_branch(self) -> str:
        if not (self.root / ".git").exists():
            return "no-git"
        try:
            cmd = ["git", "-C", str(self.root), "rev-parse", "--abbrev-ref", "HEAD"]
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return res.stdout.strip()
        except Exception as exc:
            log.warning("git branch lookup failed in %s: %s", self.root, exc)
            return "unknown-branch"

    def get_structure(self) -> Dict[str, bool]:
        return {
            "has_frontend": (self.root / "frontend").is_dir(),
            "has_backend": (self.root / "backend").is_dir(),
            "has_shared": (self.root / "shared").is_dir(),
            "has_tools": (self.root / "tools").is_dir(),
            "has_web_console": (self.root / "frontend" / "web-console").is_dir(),
            "has_admin_console": (self.root / "frontend" / "admin-console").is_dir(),
            "has_whitebox_shared": (self.root / "shared" / "whitebox").is_dir(),
            "has_scoring_shared": (self.root / "shared" / "scoring").is_dir(),
        }
