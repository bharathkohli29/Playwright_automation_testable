# Local training environment on F: (nothing is written to C: except tiny files). Run in PowerShell from the repo root:
#   powershell -ExecutionPolicy Bypass -File rca-train\setup-windows.ps1
# 1. a Python virtual environment in F:\rca-train\.venv   2. PyTorch with CUDA 12.6 (about 2.5 GB)   3. the training libraries   4. a GPU check
# Every cache and temp folder is on F: because C: was full on 4 Nov 2026.
$ErrorActionPreference = 'Stop'
$root = 'F:\rca-train'
foreach ($d in 'tmp', 'pip-cache', 'hf', 'out') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
$env:TEMP = "$root\tmp"; $env:TMP = "$root\tmp"; $env:PIP_CACHE_DIR = "$root\pip-cache"; $env:HF_HOME = "$root\hf"
$env:PIP_DEFAULT_TIMEOUT = '900'; $env:PIP_RETRIES = '10'; $env:PYTHONPYCACHEPREFIX = "$root\pycache"; $env:PYTHONDONTWRITEBYTECODE = '1'
$py = "$root\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Host '[1/4] virtual environment'; python -m venv "$root\.venv" }
& $py -m pip install --upgrade pip --disable-pip-version-check
Write-Host '[2/4] PyTorch with CUDA 12.6 (about 2.5 GB)'
& $py -m pip install torch --index-url https://download.pytorch.org/whl/cu126
Write-Host '[3/4] training libraries'
& $py -m pip install transformers peft bitsandbytes accelerate datasets huggingface_hub
Write-Host '[4/4] check the GPU'
& $py -c "import torch;print('torch',torch.__version__,'| cuda',torch.cuda.is_available(),'|',torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-')"
& $py -c "import transformers,peft,bitsandbytes;print('transformers',transformers.__version__,'peft',peft.__version__,'bitsandbytes',bitsandbytes.__version__)"
Write-Host 'SETUP-DONE'
