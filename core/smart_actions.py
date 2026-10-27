from enum import Enum
from typing import List, Optional, Dict

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
