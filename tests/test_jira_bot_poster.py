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
