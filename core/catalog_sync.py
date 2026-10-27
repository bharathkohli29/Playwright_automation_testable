import ast
import re
from pathlib import Path
from typing import Dict, List, Set, Any, Optional

class CatalogSynchronizer:
    """Introspects the platform codebase to dynamically discover and synchronize the tool catalog."""

    def __init__(self, platform_path: Path | str = "F:/ai-testable-platform"):
        self.root = Path(platform_path).resolve()
        self.technique_file = self.root / "shared" / "scoring" / "technique_tool.py"
        self.whitebox_dir = self.root / "tools" / "whitebox"

    def _parse_technique_tool_ast(self) -> Dict[str, List[str]]:
        """Parses technique_tool.py via Python AST without executing any platform code."""
        if not self.technique_file.exists():
            return {}

        try:
            content = self.technique_file.read_text(encoding="utf-8")
            tree = ast.parse(content)
        except Exception:
            return {}

        category_tools: Dict[str, List[str]] = {}

        for node in ast.walk(tree):
            # Look for module-level assignments: _NAME_CLASSIFICATION_TOOLS = { ... }
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                target_name = ""
                if isinstance(node, ast.Assign) and len(node.targets) > 0 and isinstance(node.targets[0], ast.Name):
                    target_name = node.targets[0].id
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    target_name = node.target.id

                if target_name and target_name.startswith("_") and "TOOLS" in target_name:
                    # e.g. _CYCLOMATIC_CLASSIFICATION_TOOLS -> "cyclomatic"
                    cat_match = re.search(r"_([A-Z]+)_.*TOOLS", target_name)
                    cat_key = cat_match.group(1).lower() if cat_match else target_name.lower().strip("_")

                    value_node = node.value
                    if isinstance(value_node, ast.Dict):
                        tools_found = []
                        for val in value_node.values:
                            # Values are tuples or lists of strings
                            if isinstance(val, (ast.Tuple, ast.List)):
                                for elt in val.elts:
                                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                        tool_clean = elt.value.strip().lower()
                                        if tool_clean and tool_clean not in tools_found:
                                            tools_found.append(tool_clean)
                        if tools_found:
                            category_tools[cat_key] = tools_found

        return category_tools

    def _scan_whitebox_dir(self) -> Set[str]:
        """Scans tools/whitebox for tool configuration templates across all language folders."""
        discovered: Set[str] = set()
        if not self.whitebox_dir.exists():
            return discovered

        for file_path in self.whitebox_dir.rglob("*"):
            if file_path.is_file():
                name = file_path.name.lower()
                # Extract root tool name from config files
                # e.g. eslint.config.js -> eslint, jscpd.json -> jscpd, bandit.yaml -> bandit
                # biome.json -> biome, stryker.conf.json -> stryker
                base = name.split(".")[0]
                base = base.replace("-config", "").replace("_config", "")
                base = base.split("-")[0] # e.g. eslint-sonarjs -> eslint
                
                # Check known tool naming patterns
                known_prefixes = [
                    "eslint", "jscpd", "bandit", "pylint", "semgrep", "biome", 
                    "stryker", "checkstyle", "pmd", "spotbugs", "radon", "lizard",
                    "coverlet", "coverage", "trufflehog", "gitleaks", "pip-audit",
                    "npm-audit", "cyclonedx"
                ]
                for kp in known_prefixes:
                    if kp in name:
                        discovered.add(kp)

        return discovered

    def get_registered_tools(self) -> Set[str]:
        """Returns the full set of active tools dynamically discovered from the codebase."""
        tools: Set[str] = set()
        
        # 1. From scoring technique dictionary AST
        cat_map = self._parse_technique_tool_ast()
        for t_list in cat_map.values():
            tools.update(t_list)

        # 2. From whitebox configs
        tools.update(self._scan_whitebox_dir())

        return tools

    def get_tools_by_category(self) -> Dict[str, List[str]]:
        """Returns tools grouped by scoring/taxonomy category."""
        return self._parse_technique_tool_ast()
