import subprocess
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel, Field

class BuildImpact(BaseModel):
    category: str
    should_exit_early: bool = False
    recommended_suites: List[str] = Field(default_factory=list)
    changed_files: List[str] = Field(default_factory=list)

class BuildAnalyzer:
    """Analyzes Git diff changes in the platform repository to determine testing impact."""

    def __init__(self, platform_path: Path | str = "F:/ai-testable-platform"):
        self.root = Path(platform_path).resolve()

    def get_changed_files(self, base_ref: str = "HEAD~1") -> List[str]:
        """Queries git diff for names of changed files against base_ref."""
        if not (self.root / ".git").exists():
            return []
        try:
            cmd = ["git", "-C", str(self.root), "diff", base_ref, "--name-only"]
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return [line.strip().replace("\\", "/") for line in res.stdout.splitlines() if line.strip()]
        except Exception:
            return []

    def classify_changes(self, changed_files: List[str]) -> BuildImpact:
        """Classifies changed files into execution impact zones."""
        if not changed_files:
            return BuildImpact(
                category="NO_OP",
                should_exit_early=True,
                recommended_suites=[],
                changed_files=[]
            )

        has_whitebox = False
        has_frontend = False
        has_orchestrator = False
        non_doc_files = []

        for f in changed_files:
            norm_f = f.lower().replace("\\", "/")
            
            # Check if documentation or meta file
            if norm_f.endswith((".md", ".txt", ".png", ".jpg", ".svg", ".gitignore", ".gitattributes", "license")):
                continue
            if norm_f.startswith("docs/"):
                continue

            non_doc_files.append(norm_f)

            if "tools/whitebox/" in norm_f or "shared/scoring/" in norm_f or "shared/whitebox/" in norm_f or "wb-runner" in norm_f:
                has_whitebox = True
            elif "frontend/" in norm_f:
                has_frontend = True
            elif "backend/wb-orchestrator" in norm_f or "backend/" in norm_f:
                has_orchestrator = True

        # If zero functional code files changed -> NO_OP
        if not non_doc_files:
            return BuildImpact(
                category="NO_OP",
                should_exit_early=True,
                recommended_suites=[],
                changed_files=changed_files
            )

        if has_orchestrator or (has_whitebox and has_frontend):
            return BuildImpact(
                category="FULL_RUN",
                should_exit_early=False,
                recommended_suites=["whitebox_validation", "e2e_playwright"],
                changed_files=changed_files
            )

        if has_whitebox:
            return BuildImpact(
                category="WHITEBOX",
                should_exit_early=False,
                recommended_suites=["whitebox_validation"],
                changed_files=changed_files
            )

        if has_frontend:
            return BuildImpact(
                category="E2E_UI",
                should_exit_early=False,
                recommended_suites=["e2e_playwright"],
                changed_files=changed_files
            )

        # Default fallback for unspecified backend or shared changes
        return BuildImpact(
            category="FULL_RUN",
            should_exit_early=False,
            recommended_suites=["whitebox_validation", "e2e_playwright"],
            changed_files=changed_files
        )
