"""
Service Discovery

---
id: ship-discovery
type: ship-service
version: 1.0.0
purpose: Discover ship services via Yurtle frontmatter scanning
tupugit_compliant: true
---

TupuGit-compliant service discovery: files ARE the service registry.

Instead of maintaining a JSON config file listing services, this module
scans service directories for Yurtle frontmatter that declares service
capabilities.

Each service declares itself via frontmatter in its __init__.py or service.py:

```python
\"\"\"
Service Module

---
id: wiki-service
type: mcp-service
version: 1.0.0
tools:
  - wiki_search
  - wiki_get
  - wiki_scan
---
\"\"\"
```

The discovery scans a given directory and finds all services with
`type: mcp-service` in their frontmatter.
"""

import re
import yaml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


@dataclass
class ServiceInfo:
    """Information about a discovered service."""
    id: str
    name: str
    type: str
    version: str
    description: str
    tools: List[str]
    path: Path
    status: str = "active"
    icon: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "version": self.version,
            "description": self.description,
            "tools": self.tools,
            "path": str(self.path),
            "status": self.status,
            "icon": self.icon,
            "tool_count": len(self.tools),
        }


def parse_yurtle_frontmatter(content: str) -> Optional[Dict[str, Any]]:
    """
    Parse Yurtle frontmatter from a Python docstring or markdown file.

    Frontmatter is YAML between --- markers.

    Args:
        content: File content (Python source or markdown)

    Returns:
        Parsed frontmatter dict, or None if no frontmatter found
    """
    # Pattern for frontmatter in docstrings
    # Matches: """...---\n<yaml>\n---..."""
    docstring_pattern = r'"""[^"]*?---\s*\n(.*?)\n\s*---'

    # Try docstring pattern first
    match = re.search(docstring_pattern, content, re.DOTALL)
    if match:
        yaml_content = match.group(1)
        try:
            return yaml.safe_load(yaml_content)
        except yaml.YAMLError as e:
            logger.debug(f"Failed to parse frontmatter: {e}")
            return None

    # Try markdown pattern (--- at start of file)
    if content.startswith("---"):
        lines = content.split("\n")
        end_idx = None
        for i, line in enumerate(lines[1:], 1):
            if line.strip() == "---":
                end_idx = i
                break

        if end_idx:
            yaml_content = "\n".join(lines[1:end_idx])
            try:
                return yaml.safe_load(yaml_content)
            except yaml.YAMLError:
                return None

    return None


def discover_services(service_dir: Path = None) -> List[ServiceInfo]:
    """
    Discover services by scanning for Yurtle frontmatter.

    TupuGit Principle: Files ARE the registry.

    Args:
        service_dir: Path to service directory to scan

    Returns:
        List of discovered services
    """
    if service_dir is None:
        service_dir = Path(__file__).parent.parent  # src/

    services = []

    # Scan each service directory
    for child_dir in service_dir.iterdir():
        if not child_dir.is_dir():
            continue

        if child_dir.name.startswith("_") or child_dir.name.startswith("."):
            continue

        # Look for frontmatter in these files (priority order)
        candidates = [
            child_dir / "__init__.py",
            child_dir / "service.py",
            child_dir / "README.md",
        ]

        for candidate in candidates:
            if not candidate.exists():
                continue

            try:
                content = candidate.read_text()
                frontmatter = parse_yurtle_frontmatter(content)

                if frontmatter and frontmatter.get("type") == "mcp-service":
                    service = ServiceInfo(
                        id=frontmatter.get("id", child_dir.name),
                        name=child_dir.name,
                        type=frontmatter.get("type", "mcp-service"),
                        version=frontmatter.get("version", "1.0.0"),
                        description=frontmatter.get("description", ""),
                        tools=frontmatter.get("tools", []),
                        path=child_dir,
                        status=frontmatter.get("status", "active"),
                        icon=frontmatter.get("icon", _default_icon(child_dir.name)),
                    )
                    services.append(service)
                    logger.debug(f"Discovered service: {service.id}")
                    break  # Found frontmatter, don't check other files

            except Exception as e:
                logger.debug(f"Failed to parse {candidate}: {e}")

    return services


def _default_icon(service_name: str) -> str:
    """Get default icon for a service name."""
    icons = {
        "wiki": "docs",
        "compass": "compass",
        "kanban": "board",
        "navigator": "map",
        "mcp": "ship",
    }
    return icons.get(service_name, "service")


def get_service_registry(service_dir: Path = None) -> Dict[str, ServiceInfo]:
    """
    Get the service registry as a dict keyed by service ID.

    Args:
        service_dir: Path to service directory to scan

    Returns:
        Dict mapping service ID to ServiceInfo
    """
    services = discover_services(service_dir)
    return {s.id: s for s in services}


def scan_and_report(service_dir: Path = None) -> str:
    """
    Scan for services and return a human-readable report.

    Useful for debugging service discovery.
    """
    services = discover_services(service_dir)

    lines = ["# Service Discovery Report\n"]
    lines.append(f"Scanned: {service_dir or 'src/'}")
    lines.append(f"Found: {len(services)} services\n")

    for svc in services:
        lines.append(f"## {svc.name}")
        lines.append(f"- ID: `{svc.id}`")
        lines.append(f"- Version: {svc.version}")
        lines.append(f"- Status: {svc.status}")
        lines.append(f"- Tools ({len(svc.tools)}): {', '.join(svc.tools[:5])}{'...' if len(svc.tools) > 5 else ''}")
        lines.append(f"- Path: {svc.path}")
        lines.append("")

    return "\n".join(lines)


# ==================== CLI Entry Point ====================

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    # Default to src/
    service_dir = Path(__file__).parent.parent
    if len(sys.argv) > 1:
        service_dir = Path(sys.argv[1])

    print(scan_and_report(service_dir))
