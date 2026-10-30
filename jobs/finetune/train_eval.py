"""Pactovio: tender notice text -> structured JSON. LoRA fine-tune of an NVIDIA Nemotron model on EU TED notices; base zero-shot vs tuned
on the same held-out test set. Runs inside one Nebius AI Cloud Serverless GPU job; prints `FINETUNE_REPORT {json}` at the end.
Usage: train_eval.py <data dir with train.jsonl val.jsonl test.jsonl report.json>"""
import collections, json, math, os, random, re, sys, time, traceback

T0 = time.time()
DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
BASE = os.environ.get("BASE_MODEL", "nvidia/Llama-3.1-Nemotron-Nano-4B-v1.1")
EPOCHS = int(os.environ.get("EPOCHS", "2"))
MAXLEN = 2048
FIELDS = ["deadline", "lot_count", "cpv_division", "has_estimated_value", "buyer_country"]
PROMPT = ("Extract structured fields from this EU public-procurement contract notice. Reply with JSON only, exactly these keys: "
          '{"deadline": "<earliest tender submission deadline as YYYY-MM-DD>", "lot_count": <number of lots, integer>, '
          '"cpv_division": "<2-digit CPV division of the main subject, e.g. 45 works, 33 medical, 72 IT>", '
          '"has_estimated_value": <true if an estimated value is stated, else false>, "buyer_country": "<buyer country, ISO 3166-1 alpha-3, e.g. DEU>"}\n\nNotice:\n')


def log(msg):
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


def render(text):
    return ("<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\ndetailed thinking off<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n"
            + PROMPT + text + "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n")


def read(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return [json.loads(l) for l in f]


def parse(out):
    m = re.search(r"\{.*?\}", out, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return d if isinstance(d, dict) else None
    except ValueError:
        return None


def norm(field, v):
    if v is None:
        return None
    if field == "lot_count":
        try:
            return int(float(str(v).strip()))
        except ValueError:
            return None
    if field == "has_estimated_value":
        return v if isinstance(v, bool) else str(v).strip().lower() == "true"
    if field == "deadline":
        m = re.match(r"\d{4}-\d{2}-\d{2}", str(v).strip())
        return m.group(0) if m else None
    return str(v).strip().upper() if field == "buyer_country" else str(v).strip()[:2]


def macro_f1(gold, pred):
    f1s = []
    for c in sorted(set(gold)):
        tp = sum(1 for g, p in zip(gold, pred) if g == c and p == c)
        fp = sum(1 for g, p in zip(gold, pred) if g != c and p == c)
        fn = sum(1 for g, p in zip(gold, pred) if g == c and p != c)
        f1s.append(2 * tp / (2 * tp + fp + fn) if tp else 0.0)
    return sum(f1s) / len(f1s)


def score(cases, outs):
    parsed = [parse(o) for o in outs]
    res = {"n": len(cases), "valid_json": sum(p is not None for p in parsed), "acc": {}, "exact_all": 0}
    preds = {f: [norm(f, (p or {}).get(f)) for p in parsed] for f in FIELDS}
    gold = {f: [c["label"][f] for c in cases] for f in FIELDS}
    for f in FIELDS:
        res["acc"][f] = round(sum(g == p for g, p in zip(gold[f], preds[f])) / len(cases), 4)
    res["exact_all"] = round(sum(all(preds[f][i] == gold[f][i] for f in FIELDS) for i in range(len(cases))) / len(cases), 4)
    res["deadline_exact"] = res["acc"]["deadline"]
    res["macro_acc"] = round(sum(res["acc"].values()) / len(FIELDS), 4)
    tp = sum(1 for g, p in zip(gold["has_estimated_value"], preds["has_estimated_value"]) if g and p is True)
    fp = sum(1 for g, p in zip(gold["has_estimated_value"], preds["has_estimated_value"]) if not g and p is True)
    fn = sum(1 for g, p in zip(gold["has_estimated_value"], preds["has_estimated_value"]) if g and p is not True)
    res["f1_has_estimated_value"] = round(2 * tp / max(1, 2 * tp + fp + fn), 4)
    res["macro_f1_cpv_division"] = round(macro_f1(gold["cpv_division"], [p or "" for p in preds["cpv_division"]]), 4)
    res["macro_f1_buyer_country"] = round(macro_f1(gold["buyer_country"], [p or "" for p in preds["buyer_country"]]), 4)
    res["sample_raw"] = [o[:200] for o in outs[:3]]
    return res


def answer(label):
    return json.dumps({f: label[f] for f in FIELDS}, ensure_ascii=False)


def generate(model, tok, cases, batch=16):
    import torch
    outs = []
    eos = [tok.eos_token_id, tok.convert_tokens_to_ids("<|eot_id|>")]
    order = sorted(range(len(cases)), key=lambda i: len(cases[i]["input"]))
    res = {}
    for s in range(0, len(order), batch):
        idx = order[s:s + batch]
        enc = tok([render(cases[i]["input"]) for i in idx], return_tensors="pt", padding=True, add_special_tokens=False).to("cuda")
        with torch.no_grad():
            gen = model.generate(**enc, max_new_tokens=80, do_sample=False, eos_token_id=eos, pad_token_id=tok.pad_token_id)
        for i, o in zip(idx, tok.batch_decode(gen[:, enc["input_ids"].shape[1]:], skip_special_tokens=True)):
            res[i] = o
    return [res[i] for i in range(len(cases))]


def train(model, tok, items):
    import torch
    from peft import LoraConfig, get_peft_model
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                                             target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
    model.print_trainable_parameters()
    eot = tok.convert_tokens_to_ids("<|eot_id|>")
    data = []
    for it in items:
        p = tok(render(it["input"]), add_special_tokens=False)["input_ids"]
        a = tok(answer(it["label"]), add_special_tokens=False)["input_ids"] + [eot]
        if len(p) + len(a) <= MAXLEN:
            data.append((p + a, [-100] * len(p) + a))
    mb, accum = 4, 4
    steps_total = EPOCHS * (len(data) // (mb * accum))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / max(1, int(0.06 * steps_total))) * max(0.05, 0.5 * (1 + math.cos(math.pi * s / max(1, steps_total)))))
    model.train()
    t0, step, losses = time.time(), 0, []
    for ep in range(EPOCHS):
        random.Random(ep).shuffle(data)
        for b in range(0, len(data) - mb * accum + 1, mb * accum):
            tot = 0.0
            for k in range(accum):
                chunk = data[b + k * mb:b + (k + 1) * mb]
                L = max(len(x[0]) for x in chunk)
                ids = torch.tensor([x[0] + [tok.pad_token_id] * (L - len(x[0])) for x in chunk]).cuda()
                lab = torch.tensor([x[1] + [-100] * (L - len(x[1])) for x in chunk]).cuda()
                att = torch.tensor([[1] * len(x[0]) + [0] * (L - len(x[0])) for x in chunk]).cuda()
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    loss = model(input_ids=ids, attention_mask=att, labels=lab).loss / accum
                loss.backward(); tot += loss.item()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True); step += 1; losses.append(tot)
            if step % 10 == 0 or step == 1:
                log(f"epoch {ep + 1}/{EPOCHS} step {step}/{steps_total} loss {tot:.4f}")
    torch.cuda.synchronize()
    return model, {"train_seconds": round(time.time() - t0, 1), "steps": step, "examples": len(data), "epochs": EPOCHS, "first_loss": round(losses[0], 4),
                   "last_loss": round(sum(losses[-5:]) / len(losses[-5:]), 4),
                   "lora": {"r": 16, "alpha": 32, "dropout": 0.05, "targets": "q,k,v,o,gate,up,down", "lr": 2e-4, "effective_batch": mb * accum, "max_len": MAXLEN, "dtype": "bf16"}}


def main():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    train_items, val, test = read("train.jsonl"), read("val.jsonl"), read("test.jsonl")
    rep = {"base_model": BASE, "model_licence": "NVIDIA Open Model License",
           "data_source": "EU TED v3 notices (cn-standard, published since 2026-08-01); TED data reusable: CC BY 4.0 / Commission Decision 2011/833/EU",
           "dataset": json.load(open(os.path.join(DATA, "report.json"))), "fields": FIELDS, "gpu": torch.cuda.get_device_name(0)}
    log(f"data train {len(train_items)} val {len(val)} test {len(test)}")
    t = time.time()
    tok = AutoTokenizer.from_pretrained(BASE); tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
    log(f"model loaded in {time.time() - t:.0f}s, {sum(p.numel() for p in model.parameters()) / 1e9:.2f}B params")
    t = time.time()
    rep["base_zero_shot"] = score(test, generate(model, tok, test)); rep["base_eval_seconds"] = round(time.time() - t, 1)
    log(f"BASE zero-shot: {json.dumps({k: v for k, v in rep['base_zero_shot'].items() if k != 'sample_raw'})}")
    model, rep["train"] = train(model, tok, train_items)
    model.eval()
    rep["tuned"] = score(test, generate(model, tok, test))
    log(f"TUNED: {json.dumps({k: v for k, v in rep['tuned'].items() if k != 'sample_raw'})}")
    rep["tuned_val"] = {k: v for k, v in score(val, generate(model, tok, val)).items() if k != "sample_raw"}
    maj = {f: collections.Counter(json.dumps(c["label"][f]) for c in train_items).most_common(1)[0][0] for f in FIELDS}
    rep["majority_baseline_test_acc"] = {f: round(sum(json.dumps(c["label"][f]) == maj[f] for c in test) / len(test), 3) for f in FIELDS}
    return rep


if __name__ == "__main__":
    try:
        report = main(); report["state"] = "completed"
    except Exception as exc:
        report = {"state": "failed", "error": f"{type(exc).__name__}: {str(exc)[:400]}", "trace": traceback.format_exc()[-1500:]}
    report["wall_seconds"] = round(time.time() - T0, 1)
    print("FINETUNE_REPORT " + json.dumps(report, ensure_ascii=False, separators=(",", ":")), flush=True)
    sys.exit(0 if report["state"] == "completed" else 1)
