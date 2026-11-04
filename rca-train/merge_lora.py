r"""
Merges a trained LoRA adapter into its base model and saves a normal Hugging Face model folder (safetensors) that Ollama can import.
  F:\rca-train\.venv\Scripts\python.exe rca-train\merge_lora.py --base F:\rca-train\base\Qwen2.5-1.5B-Instruct --adapter F:\rca-train\out-v0 --out F:\rca-train\merged-v0
Runs on the CPU (about 3 GB of RAM), so it does not compete with Ollama for the GPU.
"""
import argparse, os, shutil

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument('--base', required=True); ap.add_argument('--adapter', required=True); ap.add_argument('--out', required=True)
a = ap.parse_args()
base, adapter, out = (os.path.expanduser(x) for x in (a.base, a.adapter, a.out))
model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, device_map={'': 'cpu'})
model = PeftModel.from_pretrained(model, adapter).merge_and_unload()
if os.path.isdir(out): shutil.rmtree(out)
model.save_pretrained(out, safe_serialization=True)
AutoTokenizer.from_pretrained(base).save_pretrained(out)
print('MERGED', out, round(sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / 1e9, 2), 'GB')
