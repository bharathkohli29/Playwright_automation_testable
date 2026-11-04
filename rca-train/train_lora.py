r"""
Local QLoRA fine-tune of the RCA writer. Runs on THIS PC only (no cloud): 4-bit base model + a small LoRA adapter, one example at a time,
gradient checkpointing, an 8-bit optimizer, so it fits a 4 GB GPU with a 1.5B base model. Set TEMP, HF_HOME and PIP_CACHE_DIR to F: first (rca-train/setup-windows.ps1 does it).

Run it with the environment on F: (see rca-train/README.md):
  F:\rca-train\.venv\Scripts\python.exe rca-train\train_lora.py --data train.jsonl --base F:\rca-train\base\Qwen2.5-1.5B-Instruct --out F:\rca-train\out-1

Data: the train.jsonl written by  npm run rca:dataset -- import ...  (chat format: system, user, assistant per line).
For a MEASUREMENT run only (no reviewed data yet) --from-facts takes the facts.jsonl of an export and uses the unreviewed draft as the answer.
Such an adapter has learned its own drafts and must never be used.
"""
import argparse, json, os, random, time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
import bitsandbytes as bnb

ap = argparse.ArgumentParser()
ap.add_argument('--data', required=True); ap.add_argument('--base', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--from-facts', action='store_true', help='measurement only: facts.jsonl with unreviewed drafts as answers')
ap.add_argument('--epochs', type=int, default=2); ap.add_argument('--max-steps', type=int, default=0, help='stop after this many optimizer steps (0 = all epochs)')
ap.add_argument('--max-len', type=int, default=1536); ap.add_argument('--accum', type=int, default=8); ap.add_argument('--lr', type=float, default=2e-4)
ap.add_argument('--rank', type=int, default=16); ap.add_argument('--seed', type=int, default=7)
a = ap.parse_args()
random.seed(a.seed); torch.manual_seed(a.seed)
base = os.path.expanduser(a.base); out = os.path.expanduser(a.out); os.makedirs(out, exist_ok=True)

tok = AutoTokenizer.from_pretrained(base)
rows = [json.loads(l) for l in open(a.data, encoding='utf8') if l.strip()]
def messages(r):
    if not a.from_facts: return r['messages']
    d = r['draft']; ans = json.dumps({k: d[k] for k in ('oneLine', 'whatHappened', 'why', 'impact', 'fix')}, ensure_ascii=False)
    return [{'role': 'system', 'content': r['system']}, {'role': 'user', 'content': r['user']}, {'role': 'assistant', 'content': ans}]

data, dropped, lens = [], 0, []
for r in rows:
    m = messages(r)
    prompt = tok.apply_chat_template(m[:-1], tokenize=False, add_generation_prompt=True); full = tok.apply_chat_template(m, tokenize=False)
    assert full.startswith(prompt), 'the chat template does not extend the prompt: cannot mask it'
    p_ids = tok(prompt, add_special_tokens=False)['input_ids']; f_ids = tok(full, add_special_tokens=False)['input_ids']
    if len(f_ids) > a.max_len: dropped += 1; continue
    lens.append(len(f_ids)); data.append((torch.tensor(f_ids), torch.tensor([-100] * len(p_ids) + f_ids[len(p_ids):])))  # the loss is only on the answer
print(f'examples: {len(data)} (dropped {dropped} longer than {a.max_len} tokens) | tokens per example: mean {sum(lens)//max(1,len(lens))}, max {max(lens) if lens else 0}', flush=True)
if not data: raise SystemExit('no example to train on')

bnb_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)
model = AutoModelForCausalLM.from_pretrained(base, quantization_config=bnb_cfg, device_map={'': 0}, dtype=torch.bfloat16)
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, task_type='CAUSAL_LM', target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj']))
model.print_trainable_parameters()
opt = bnb.optim.AdamW8bit([p for p in model.parameters() if p.requires_grad], lr=a.lr)  # only the small LoRA weights are trained, so no paged optimizer is needed (it is unreliable on Windows)
steps_total = a.max_steps or (a.epochs * len(data)) // a.accum
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 3) * max(0.1, 1 - s / max(1, steps_total)))  # short warm-up, linear decay
model.train(); torch.cuda.reset_peak_memory_stats()
t0 = time.time(); step = 0; micro = 0; tokens = 0; losses = []; ok = True; err = ''
try:
    for ep in range(a.epochs):
        order = list(range(len(data))); random.shuffle(order)
        for i in order:
            ids, labels = data[i]; ids = ids.unsqueeze(0).cuda(); labels = labels.unsqueeze(0).cuda()
            loss = model(input_ids=ids, labels=labels).loss; (loss / a.accum).backward(); losses.append(loss.item()); tokens += ids.numel(); micro += 1
            if micro % a.accum == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1
                print(f'step {step}/{steps_total} | loss {sum(losses[-a.accum:]) / a.accum:.3f} | {tokens / (time.time() - t0):.0f} tokens/s | peak GPU {torch.cuda.max_memory_allocated() / 2**30:.2f} GB', flush=True)
                if a.max_steps and step >= a.max_steps: raise StopIteration
except StopIteration:
    pass
except torch.cuda.OutOfMemoryError as e:
    ok = False; err = 'out of GPU memory: lower --max-len, or use a smaller base model'; print('FAILED:', err, flush=True)
secs = time.time() - t0
if ok: model.save_pretrained(out); tok.save_pretrained(out)
rep = {'ok': ok, 'error': err, 'base': base, 'examples': len(data), 'dropped_too_long': dropped, 'optimizer_steps': step, 'seconds': round(secs, 1), 'tokens_per_second': round(tokens / max(1, secs)),
       'peak_gpu_allocated_gb': round(torch.cuda.max_memory_allocated() / 2**30, 2), 'peak_gpu_reserved_gb': round(torch.cuda.max_memory_reserved() / 2**30, 2),
       'first_loss': round(sum(losses[:a.accum]) / max(1, len(losses[:a.accum])), 3) if losses else None, 'last_loss': round(sum(losses[-a.accum:]) / max(1, len(losses[-a.accum:])), 3) if losses else None,
       'measurement_only': a.from_facts}
json.dump(rep, open(os.path.join(out, 'train-report.json'), 'w'), indent=2); print(json.dumps(rep, indent=2), flush=True)
