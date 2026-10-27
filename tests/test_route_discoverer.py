import pytest
from pathlib import Path
from core.route_discoverer import RouteDiscoverer

def test_route_discoverer_on_mock_app(tmp_path):
    mock_app = tmp_path / "mock_app"
    mock_app.mkdir()
    (mock_app / "page.tsx").write_text("// Home page", encoding="utf-8")
    
    auth_dir = mock_app / "auth" / "login"
    auth_dir.mkdir(parents=True)
    (auth_dir / "page.tsx").write_text("// Login page", encoding="utf-8")
    
    runs_dir = mock_app / "runs" / "[runId]"
    runs_dir.mkdir(parents=True)
    (runs_dir / "page.tsx").write_text("// Run page", encoding="utf-8")
    
    discoverer = RouteDiscoverer(app_root=mock_app)
    routes = discoverer.get_routes()
    
    assert "/" in routes
    assert "/auth/login" in routes
    assert "/runs/[runId]" in routes
    
    assert discoverer.has_route("/auth/login") is True
    assert discoverer.has_route("/non-existent") is False
    
    # Test dynamic param resolution
    resolved = discoverer.resolve_route("/runs/[runId]", runId="run-9988")
    assert resolved == "/runs/run-9988"


def test_route_discoverer_on_live_platform():
    live_web_console = Path("F:/ai-testable-platform/frontend/web-console/src/app")
    if not live_web_console.exists():
        pytest.skip("Live web-console app dir not found")
        
    discoverer = RouteDiscoverer(app_root=live_web_console)
    routes = discoverer.get_routes()
    
    assert "/" in routes
    assert "/dashboard" in routes
    assert "/auth/login" in routes or "/login" in routes
    assert "/runs/[runId]" in routes
    
    resolved = discoverer.resolve_route("/runs/[runId]", runId="val-run-123")
    assert resolved == "/runs/val-run-123"
