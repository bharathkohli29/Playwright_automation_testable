import re
from pathlib import Path
from typing import Dict, List, Set, Optional
from core.config import DEFAULT_PLATFORM_PATH

class RouteDiscoverer:
    """Scans Next.js App Router directory trees to discover live routes and parameter placeholders."""

    def __init__(self, app_root: Path | str = f"{DEFAULT_PLATFORM_PATH}/frontend/web-console/src/app"):
        self.app_root = Path(app_root).resolve()
        self._routes: Optional[List[str]] = None

    def _scan(self) -> List[str]:
        if not self.app_root.exists() or not self.app_root.is_dir():
            return []

        routes = []
        page_files = list(self.app_root.rglob("page.tsx")) + \
                     list(self.app_root.rglob("page.jsx")) + \
                     list(self.app_root.rglob("page.js"))

        for pf in page_files:
            rel_dir = pf.relative_to(self.app_root).parent
            rel_str = str(rel_dir).replace("\\", "/")
            if rel_str in (".", ""):
                route = "/"
            else:
                route = "/" + rel_str
            routes.append(route)

        return sorted(routes)

    def get_routes(self) -> List[str]:
        """Returns all live Next.js App Router paths discovered from page.tsx files."""
        if self._routes is None:
            self._routes = self._scan()
        return self._routes

    def has_route(self, route_pattern: str) -> bool:
        """Checks if a route pattern exists in the discovered routes."""
        normalized = route_pattern.strip()
        if not normalized.startswith("/"):
            normalized = "/" + normalized
        return normalized in self.get_routes()

    def resolve_route(self, route_pattern: str, **params) -> str:
        """Substitutes dynamic segment placeholders (e.g. [runId] or [[...slug]]) with actual values."""
        resolved = route_pattern
        for key, val in params.items():
            # Matches [key] or [[...key]] or [...key]
            pattern = re.compile(rf"\[\[?\.\.\.?{key}\]?\]")
            resolved = pattern.sub(str(val), resolved)
            resolved = resolved.replace(f"[{key}]", str(val))
        return resolved
