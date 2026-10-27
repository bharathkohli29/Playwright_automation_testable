import time
from enum import Enum
from typing import List, Optional, Dict, Any

# NOTE: reference implementation, unit-tested but NOT yet called by the Playwright (TypeScript) suite in
# pages/MergeFlowPage.ts. The "self-healing UI" behaviour only applies once that suite uses an equivalent.

class ActionIntent(str, Enum):
    AUTH = "AUTH"
    TRIGGER = "TRIGGER"
    EXPORT = "EXPORT"
    CREATE = "CREATE"
    CONFIRM = "CONFIRM"
    DELETE = "DELETE"

_INTENT_SYNONYMS: Dict[ActionIntent, List[str]] = {
    ActionIntent.AUTH: [
        "Login", "Log In", "Sign In", "Continue", "Proceed", "Submit", "Next"
    ],
    ActionIntent.TRIGGER: [
        "Run Scan", "Start Analysis", "Scan Now", "Trigger", "Execute", "Launch Analysis", "Run"
    ],
    ActionIntent.EXPORT: [
        "Download Report", "Export PDF", "Get Gate Summary", "Export", "Download", "Save Summary"
    ],
    ActionIntent.CREATE: [
        "Create", "New", "Add", "Generate", "Build", "Save New"
    ],
    ActionIntent.CONFIRM: [
        "Confirm", "Accept", "OK", "Yes", "Save Changes", "Save", "Apply"
    ],
    ActionIntent.DELETE: [
        "Delete", "Remove", "Discard", "Cancel"
    ]
}

class SmartActionResolver:
    """Self-healing button action resolver that handles renamed buttons and layout shifts."""

    def __init__(self):
        self.synonyms = _INTENT_SYNONYMS

    def resolve_button_selectors(
        self,
        intent: ActionIntent | str,
        fallback_text: Optional[str] = None
    ) -> List[str]:
        """Generates an ordered list of resilient Playwright locators for a semantic intent."""
        if isinstance(intent, str):
            try:
                intent = ActionIntent(intent.upper())
            except ValueError:
                intent = None

        candidates = []
        if fallback_text:
            candidates.append(fallback_text)

        if intent and intent in self.synonyms:
            candidates.extend(self.synonyms[intent])

        selectors = []
        # 1. Text-based button locators
        for text in candidates:
            selectors.append(f"button:has-text('{text}')")
            selectors.append(f"a:has-text('{text}')")
            selectors.append(f"[role='button']:has-text('{text}')")

        # 2. Functional role fallbacks
        if intent == ActionIntent.AUTH:
            selectors.append("button[type='submit']")
            selectors.append("form button[type='submit']")
            selectors.append("input[type='submit']")

        return selectors

    def get_kebab_unfurl_selectors(self) -> List[str]:
        """Locators for 3-dots kebab action dropdown triggers in table rows or cards."""
        return [
            "[aria-label='Actions']",
            "[aria-label='actions']",
            "[aria-label='More options']",
            "button:has(svg)",
            "button:has-text('...')",
            "button:has-text('…')"
        ]

    def click_intent(
        self,
        page: Any,
        intent: ActionIntent | str,
        fallback_text: Optional[str] = None,
        timeout_ms: int = 5000
    ) -> bool:
        """Attempts to click a button by intent, with auto-scroll and 3-dots kebab menu fallback."""
        selectors = self.resolve_button_selectors(intent, fallback_text=fallback_text)

        # Attempt direct matches first
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=1000):
                    loc.scroll_into_view_if_needed()
                    loc.click(timeout=timeout_ms)
                    return True
            except Exception:
                continue

        # If not visible directly, attempt unfurling kebab dropdowns (...)
        for kebab in self.get_kebab_unfurl_selectors():
            try:
                k_loc = page.locator(kebab).first
                if k_loc.is_visible(timeout=500):
                    k_loc.click()
                    time.sleep(0.3)
                    # Re-attempt finding target inside opened dropdown
                    for sel in selectors:
                        try:
                            loc = page.locator(sel).first
                            if loc.is_visible(timeout=1000):
                                loc.click(timeout=timeout_ms)
                                return True
                        except Exception:
                            continue
            except Exception:
                continue

        return False
