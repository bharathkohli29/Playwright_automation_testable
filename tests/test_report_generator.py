import pytest
from pathlib import Path
from core.report_generator import ReportGenerator

def test_report_generator_mock(tmp_path):
    gen = ReportGenerator(output_dir=tmp_path)
    run_data = {
        "run_id": "test-run-123",
        "branch": "main",
        "commit": "abc1234",
        "pass_rate": "95.0%",
        "total_tools": 20,
        "passed_tools": 19,
        "failed_tools": 1,
        "not_applicable": 0,
        "rows": [
            {"tt": "Whitebox Static", "tech": "Complexity", "cls": "Cyclomatic", "status": "Execution completed", "result": "PASS"},
            {"tt": "Whitebox Static", "tech": "SAST", "cls": "Vulnerability", "status": "Tool failed", "result": "FAIL"}
        ]
    }

    excel_file = gen.generate_excel_tracker(run_data, filename="test_results.xlsx")
    assert excel_file.exists()
    assert excel_file.stat().st_size > 1000

    pdf_file = gen.generate_pdf_report(run_data, filename="test_review.pdf")
    assert pdf_file.exists()
    assert pdf_file.stat().st_size > 1000


def test_report_generator_on_real_v21_data(tmp_path):
    v21_path = Path("F:/ts_work/v21")
    if not v21_path.exists():
        pytest.skip("F:/ts_work/v21 not found")

    gen = ReportGenerator(output_dir=tmp_path)
    parsed = gen.parse_run_directory(v21_path)

    assert parsed["run_id"] == "54f00333-52e4-48e3-bc76-3a2b3c1ac7c6"
    assert parsed["total_tools"] == 131
    assert parsed["passed_tools"] > 0

    excel_file = gen.generate_excel_tracker(parsed)
    pdf_file = gen.generate_pdf_report(parsed)

    assert excel_file.exists()
    assert pdf_file.exists()
