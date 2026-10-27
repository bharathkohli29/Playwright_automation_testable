import pytest
from core.jira_bot_poster import JiraBotPoster, JiraDeliverablePayload

def test_jira_bot_poster_markdown_formatting():
    poster = JiraBotPoster(dry_run=True)
    payload = JiraDeliverablePayload(
        issue_key="TP-6246",
        run_id="v21-run-99",
        pass_rate="92.5%",
        total_tools=12,
        passed_tools=11,
        failed_tools=1,
        excel_name="Tool_Execution_Results.xlsx",
        pdf_name="Executive_Review.pdf",
        bluf_summary="Build v21 validated cleanly. 1 container defect identified in lizard."
    )
    
    comment_body = poster.format_jira_comment(payload)
    
    # Must use native pills [^filename.ext]
    assert "[^Tool_Execution_Results.xlsx]" in comment_body
    assert "[^Executive_Review.pdf]" in comment_body
    
    # Must contain BLUF summary
    assert "EXECUTIVE SUMMARY (BLUF)" in comment_body
    assert "92.5%" in comment_body
    assert "TP-6246" in comment_body


def test_jira_bot_poster_dry_run_post():
    poster = JiraBotPoster(dry_run=True)
    payload = JiraDeliverablePayload(
        issue_key="TP-6246",
        run_id="v21-run-99",
        pass_rate="100%",
        total_tools=10,
        passed_tools=10,
        failed_tools=0,
        excel_name="results.xlsx",
        pdf_name="report.pdf",
        bluf_summary="All tools passed."
    )
    
    res = poster.post_deliverables(payload, file_paths=[])
    assert res["status"] == "dry_run_success"
    assert res["issue_key"] == "TP-6246"


def test_jira_bot_poster_live_upload_and_comment(tmp_path):
    from unittest.mock import patch, MagicMock
    poster = JiraBotPoster(
        jira_url="https://testable.atlassian.net",
        username="qa@testable.ai",
        api_token="test_token_xyz",
        dry_run=False
    )

    test_file = tmp_path / "summary.xlsx"
    test_file.write_text("dummy excel content")

    payload = JiraDeliverablePayload(
        issue_key="TP-6246",
        run_id="v21-run-100",
        pass_rate="100%",
        total_tools=5,
        passed_tools=5,
        failed_tools=0,
        excel_name="summary.xlsx",
        pdf_name="summary.pdf",
        bluf_summary="Automated run validated."
    )

    mock_resp = MagicMock()
    mock_resp.status_code = 201

    with patch("requests.post", return_value=mock_resp) as mock_post:
        res = poster.post_deliverables(payload, file_paths=[test_file])
        assert res["status"] == "published"
        assert "summary.xlsx" in res["attached_files"]
        assert res["comment_posted"] is True
        # Verify both attachment upload and comment post were executed
        assert mock_post.call_count == 2
