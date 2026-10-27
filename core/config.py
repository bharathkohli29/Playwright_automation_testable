import logging
import os

logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(name)s: %(message)s")

# Override with the PLATFORM_PATH environment variable (e.g. in CI); the old default is unchanged.
DEFAULT_PLATFORM_PATH = os.environ.get("PLATFORM_PATH", "F:/ai-testable-platform")
