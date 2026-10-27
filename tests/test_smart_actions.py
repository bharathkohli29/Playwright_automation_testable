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
