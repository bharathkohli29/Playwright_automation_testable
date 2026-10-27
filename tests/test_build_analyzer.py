import pytest
from pathlib import Path
from core.build_analyzer import BuildAnalyzer, BuildImpact

def test_build_analyzer_docs_only():
    changed = ["README.md", "docs/architecture.md", ".gitignore"]
    analyzer = BuildAnalyzer()
    impact = analyzer.classify_changes(changed)
    
    assert impact.category == "NO_OP"
    assert impact.should_exit_early is True
    assert impact.recommended_suites == []


def test_build_analyzer_whitebox_tools():
    changed = ["shared/scoring/technique_tool.py", "tools/whitebox/python/bandit.yaml"]
    analyzer = BuildAnalyzer()
    impact = analyzer.classify_changes(changed)
    
    assert impact.category == "WHITEBOX"
    assert impact.should_exit_early is False
    assert "whitebox_validation" in impact.recommended_suites


def test_build_analyzer_frontend_ui():
    changed = ["frontend/web-console/src/app/login/page.tsx", "frontend/web-console/src/components/Button.tsx"]
    analyzer = BuildAnalyzer()
    impact = analyzer.classify_changes(changed)
    
    assert impact.category == "E2E_UI"
    assert impact.should_exit_early is False
    assert "e2e_playwright" in impact.recommended_suites


def test_build_analyzer_backend_orchestrator():
    changed = ["backend/wb-orchestrator/celery_app.py"]
    analyzer = BuildAnalyzer()
    impact = analyzer.classify_changes(changed)
    
    assert impact.category == "FULL_RUN"
    assert impact.should_exit_early is False
    assert "whitebox_validation" in impact.recommended_suites
    assert "e2e_playwright" in impact.recommended_suites
