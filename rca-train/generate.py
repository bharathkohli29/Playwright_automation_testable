r"""
Generates answers for a held-out file from the base model and from base + trained adapter, with the same prompts, greedy decoding.
No Ollama needed. Writes one JSONL per condition: {"id", "answer", "seconds"}.
  F:\rca-train\.venv\Scripts\python.exe rca-train\generate.py --data results\rca-dataset\v1\holdout.jsonl --base F:\rca-train\base\Qwen2.5-1.5B-Instruct --adapter F:\rca-train\out-v0 --out F:\rca-train\gen-v0
Note: Ollama can force valid JSON with a schema; here nothing forces it, so a model that writes valid JSON by itself is showing what it learned.
"""
import argparse, json, os, time

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

ap = argparse.ArgumentParser()
ap.add_argument('--data', required=True); ap.add_argument('--base', required=True); ap.add_argument('--adapter', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--max-new', type=int, default=700)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
tok = AutoTokenizer.from_pretrained(a.base)
rows = [json.loads(l) for l in open(a.data, encoding='utf8') if l.strip()]
bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)
model = AutoModelForCausalLM.from_pretrained(a.base, quantization_config=bnb, device_map={'': 0}, dtype=torch.bfloat16)
model = PeftModel.from_pretrained(model, a.adapter); model.eval()

def gen(msgs):
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors='pt', return_dict=True).to('cuda')
    t0 = time.time()
    with torch.no_grad(): o = model.generate(**ids, max_new_tokens=a.max_new, do_sample=False, pad_token_id=tok.eos_token_id)
    return tok.decode(o[0][ids['input_ids'].shape[1]:], skip_special_tokens=True).strip(), time.time() - t0

for cond in ('base', 'v0'):
    with open(os.path.join(a.out, f'{cond}.jsonl'), 'w', encoding='utf8') as f:
        for r in rows:
            msgs = r['messages'][:2]
            if cond == 'base':
                with model.disable_adapter(): ans, sec = gen(msgs)
            else: ans, sec = gen(msgs)
            f.write(json.dumps({'id': r['id'], 'answer': ans, 'seconds': round(sec, 1)}, ensure_ascii=False) + '\n'); f.flush()
            print(cond, r['id'], f'{sec:.0f}s', flush=True)
print('GENERATED', a.out)
