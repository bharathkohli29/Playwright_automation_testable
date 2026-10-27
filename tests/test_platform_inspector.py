import pytest
from pathlib import Path
from core.platform_inspector import PlatformInspector

def test_platform_inspector_directory_validation(tmp_path):
    # Mock platform structure
    platform_dir = tmp_path / "mock_platform"
    platform_dir.mkdir()
    (platform_dir / "VERSION").write_text("1.4.0\n")
    (platform_dir / "frontend").mkdir()
    (platform_dir / "backend").mkdir()
    (platform_dir / "shared").mkdir()
    (platform_dir / "tools").mkdir()
    
    inspector = PlatformInspector(platform_path=platform_dir)
    assert inspector.is_valid_platform_root() is True
    assert inspector.get_version() == "1.4.0"
    
    dirs = inspector.get_structure()
    assert dirs["has_frontend"] is True
    assert dirs["has_backend"] is True
    assert dirs["has_shared"] is True
    assert dirs["has_tools"] is True

def test_platform_inspector_invalid_dir(tmp_path):
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    inspector = PlatformInspector(platform_path=empty_dir)
    assert inspector.is_valid_platform_root() is False

def test_platform_inspector_on_real_codebase():
    real_path = Path("F:/ai-testable-platform")
    if not real_path.exists():
        pytest.skip("F:/ai-testable-platform not found on machine")
    
    inspector = PlatformInspector(platform_path=real_path)
    assert inspector.is_valid_platform_root() is True
    assert inspector.get_version() != ""
    assert inspector.get_git_commit() != ""
