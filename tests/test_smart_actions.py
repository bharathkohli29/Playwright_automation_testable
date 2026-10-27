import pytest
from core.smart_actions import SmartActionResolver, ActionIntent

def test_smart_action_auth_intent():
    resolver = SmartActionResolver()
    selectors = resolver.resolve_button_selectors(ActionIntent.AUTH)
    
    # Must contain primary synonyms
    selector_str = " ".join(selectors)
    assert 'Login' in selector_str or 'login' in selector_str.lower()
    assert 'Continue' in selector_str
    assert 'Sign In' in selector_str
    # Must include form submit fallback
    assert "button[type='submit']" in selectors or any("submit" in s for s in selectors)


def test_smart_action_trigger_intent():
    resolver = SmartActionResolver()
    selectors = resolver.resolve_button_selectors(ActionIntent.TRIGGER)
    
    selector_str = " ".join(selectors)
    assert 'Run Scan' in selector_str
    assert 'Scan Now' in selector_str
    assert 'Start Analysis' in selector_str


def test_smart_action_kebab_unfurl():
    resolver = SmartActionResolver()
    kebab_selectors = resolver.get_kebab_unfurl_selectors()
    
    assert any("[aria-label='Actions']" in s for s in kebab_selectors)
    assert any("button:has(svg)" in s for s in kebab_selectors)


def test_smart_action_custom_fallback():
    resolver = SmartActionResolver()
    selectors = resolver.resolve_button_selectors(ActionIntent.AUTH, fallback_text="Custom Authenticate")
    
    assert any("Custom Authenticate" in s for s in selectors)


def test_smart_action_click_intent_direct():
    from unittest.mock import MagicMock
    resolver = SmartActionResolver()
    page = MagicMock()
    mock_locator = MagicMock()
    mock_locator.is_visible.return_value = True
    page.locator.return_value.first = mock_locator

    success = resolver.click_intent(page, ActionIntent.TRIGGER)
    assert success is True
    mock_locator.click.assert_called_once()


def test_smart_action_click_intent_kebab_fallback():
    from unittest.mock import MagicMock
    resolver = SmartActionResolver()
    page = MagicMock()

    # Direct locator fails visibility, kebab succeeds
    loc_counter = {"call": 0}
    def mock_loc(sel):
        m = MagicMock()
        if "Actions" in sel:
            m.first.is_visible.return_value = True
            return m
        elif "Scan Now" in sel and loc_counter["call"] > 0:
            m.first.is_visible.return_value = True
            return m
        else:
            m.first.is_visible.return_value = False
            return m

    page.locator.side_effect = mock_loc
    # When kebab is clicked, subsequent button becomes visible
    loc_counter["call"] = 1
    success = resolver.click_intent(page, ActionIntent.TRIGGER)
    assert success is True
