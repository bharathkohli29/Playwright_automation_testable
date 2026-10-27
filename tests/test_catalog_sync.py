import pytest
from pathlib import Path
from core.catalog_sync import CatalogSynchronizer

def test_catalog_sync_on_mock_codebase(tmp_path):
    mock_platform = tmp_path / "mock_platform"
    mock_platform.mkdir()
    
    scoring_dir = mock_platform / "shared" / "scoring"
    scoring_dir.mkdir(parents=True)
    
    technique_content = '''
_CYCLOMATIC_CLASSIFICATION_TOOLS: dict[str, tuple[str, ...]] = {
    "Condition Coverage": ("pymcdc",),
    "Decision Coverage": ("coverage-py", "coverlet", "jacoco", "nyc-mocha"),
    "Maintainability Analysis": ("radon", "lizard"),
}
_SAST_CLASSIFICATION_TOOLS: dict[str, tuple[str, ...]] = {
    "Secure Coding Validation": ("bandit", "semgrep", "spotbugs"),
    "Dependency Vulnerability": ("pip-audit", "npm-audit"),
}
_SECRET_CLASSIFICATION_TOOLS: dict[str, tuple[str, ...]] = {
    "Hardcoded Secret Detection": ("gitleaks", "detect-secrets"),
}
'''
    (scoring_dir / "technique_tool.py").write_text(technique_content, encoding="utf-8")
    
    # Mock tools/whitebox
    wb_dir = mock_platform / "tools" / "whitebox"
    (wb_dir / "javascript").mkdir(parents=True)
    (wb_dir / "javascript" / "eslint.config.js").write_text("// eslint config", encoding="utf-8")
    (wb_dir / "javascript" / "jscpd.json").write_text("{}", encoding="utf-8")
    
    (wb_dir / "python").mkdir(parents=True)
    (wb_dir / "python" / "bandit.yaml").write_text("{}", encoding="utf-8")
    (wb_dir / "python" / "pylint.cfg").write_text("", encoding="utf-8")

    sync = CatalogSynchronizer(platform_path=mock_platform)
    tools = sync.get_registered_tools()
    
    assert "pymcdc" in tools
    assert "coverage-py" in tools
    assert "coverlet" in tools
    assert "lizard" in tools
    assert "bandit" in tools
    assert "semgrep" in tools
    assert "gitleaks" in tools
    assert "eslint" in tools
    assert "jscpd" in tools
    assert "pylint" in tools

    categories = sync.get_tools_by_category()
    assert "cyclomatic" in categories
    assert "sast" in categories
    assert "secret" in categories
    assert "lizard" in categories["cyclomatic"]
    assert "bandit" in categories["sast"]
    assert "gitleaks" in categories["secret"]


def test_catalog_sync_on_live_platform():
    live_path = Path("F:/ai-testable-platform")
    if not live_path.exists():
        pytest.skip("F:/ai-testable-platform not available")
        
    sync = CatalogSynchronizer(platform_path=live_path)
    tools = sync.get_registered_tools()
    
    # Must discover core tools dynamically
    assert "lizard" in tools
    assert "bandit" in tools
    assert "semgrep" in tools
    assert "coverage-py" in tools
    assert "coverlet" in tools
    assert "gitleaks" in tools
    assert len(tools) >= 15
