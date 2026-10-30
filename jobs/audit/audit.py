"""Pactovio audit job. Runs inside a Nebius Serverless Job (python:3.12-slim) or locally.

Labels used in the output:
  nemo.regex_output_rail       NeMo Guardrails library rail ("regex check output"), our claim-type patterns
  ours.claim_audit             our custom NeMo action (ours_actions.py + claims.py)
  nemo.self_check_facts        NeMo library rail; judge = Nemotron 3.5 Super VL on Token Factory
"""
import asyncio
import json
import os
import re
import sys
import time
import urllib.request

APP_URL = os.environ.get("APP_URL", "").rstrip("/")
INGEST_SECRET = os.environ.get("INGEST_SECRET", "")
JOB_ID = os.environ.get("JOB_ID") or os.environ.get("NEBIUS_JOB_ID") or f"local-{int(time.time())}"
OFFLINE = os.environ.get("AUDIT_OFFLINE") == "1"      # skip the live self check (no LLM calls)
RED_TEAM_ON = os.environ.get("AUDIT_RED_TEAM", "1") == "1"
MAX_FLAGGED = int(os.environ.get("AUDIT_MAX_FLAGGED", "12"))   # live self-check calls per audit
os.environ.setdefault("OPENAI_API_KEY", os.environ.get("NEBIUS_API_KEY", ""))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

JUDGE_PRIMARY = "nvidia/Nemotron-3.5-Super-VL"
JUDGE_FALLBACK = "nvidia/nemotron-3-super-120b-a12b"   # same as the app's text fallback


def pick_judge() -> str:
    """Use Super VL unless Token Factory no longer lists it (it vanished for a while on 30 Oct 2026); a failed check keeps it."""
    try:
        req = urllib.request.Request("https://api.tokenfactory.nebius.com/v1/models",
                                     headers={"authorization": f"Bearer {os.environ.get('NEBIUS_API_KEY', '')}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            ids = {m.get("id") for m in json.loads(r.read()).get("data", [])}
        return JUDGE_PRIMARY if JUDGE_PRIMARY in ids or not ids else JUDGE_FALLBACK
    except Exception:  # noqa: BLE001 - availability probe only
        return JUDGE_PRIMARY


JUDGE = JUDGE_PRIMARY if OFFLINE else pick_judge()

NO_OTHER_RAILS = {"input": False, "retrieval": False, "dialog": False, "tool_input": False, "tool_output": False}


def http(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        APP_URL + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"x-ingest-secret": INGEST_SECRET, "content-type": "application/json", "user-agent": "pactovio-audit-job/1"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])|\n+", text.strip())
    return [p.strip() for p in parts if len(p.strip()) > 12]


def _rails_opts() -> dict:
    return {"rails": {**NO_OTHER_RAILS, "output": True}, "log": {"activated_rails": True}}


def build_rails(path: str) -> dict:
    """One LLMRails per output rail, so each rail's verdict is attributable (NeMo 0.24 runs every configured output flow)."""
    from nemoguardrails import LLMRails, RailsConfig
    import ours_actions
    out = {}
    for flow in ("regex check output", "claim audit", "self check facts"):
        cfg = RailsConfig.from_path(path)
        cfg.rails.output.flows = [flow]
        for m in cfg.models:
            if m.type == "main":
                m.model = JUDGE
        r = LLMRails(cfg)
        r.register_action(ours_actions.claim_audit, "claim_audit")
        out[flow] = r
    return out


async def run_rail(rails_map: dict, flow: str, question: str, claim: str, chunks: list[str], check_facts: bool = False) -> dict:
    ctx = {"relevant_chunks": "\n".join(chunks)}  # NeMo concatenates this as a string
    if check_facts:
        ctx["check_facts"] = True
    msgs = [{"role": "context", "content": ctx}, {"role": "user", "content": question or "Answer the question."}, {"role": "assistant", "content": claim}]
    t0 = time.time()
    res = await rails_map[flow].generate_async(messages=msgs, options=_rails_opts())
    ms = int((time.time() - t0) * 1000)
    blocked, details = False, {}
    for ar in (res.log.activated_rails if res.log else []):
        if ar.stop:
            blocked = True
        for ea in ar.executed_actions:
            rv = ea.return_value
            md = getattr(rv, "metadata", None) or (rv.get("metadata") if isinstance(rv, dict) else None)
            if md:
                details.update({k: v for k, v in md.items() if k != "text"})
    return {"blocked": blocked, "ms": ms, "details": details}


async def audit_sentence(rails, actions_mod, question: str, sent: str, chunks: list[str], live_budget: list[int]) -> dict:
    from claims import extract
    regex = await run_rail(rails, "regex check output", question, sent, chunks)
    claim = {"text": sent, "nemo_regex_output_rail": {"flagged": regex["blocked"], "detections": regex["details"].get("detections", [])}}
    if not regex["blocked"]:
        claim["verdict"] = "no_claim_flagged"
        return claim
    claim["claims"] = extract(sent)
    ours = await run_rail(rails, "claim audit", question, sent, chunks)
    audit = actions_mod.LAST_AUDIT.get(sent, {})
    claim["ours_claim_audit"] = {"supported": not ours["blocked"], "unsupported": audit.get("unsupported", []), "evidence_empty": audit.get("evidence_empty", not chunks)}
    if OFFLINE or live_budget[0] <= 0:
        claim["nemo_self_check_facts"] = {"skipped": "offline" if OFFLINE else "budget"}
        sc_ok = True
    else:
        live_budget[0] -= 1
        sc = await run_rail(rails, "self check facts", question, sent, chunks, check_facts=True)
        claim["nemo_self_check_facts"] = {"supported": not sc["blocked"], "ms": sc["ms"], "accuracy": sc["details"].get("accuracy")}
        sc_ok = not sc["blocked"]
    claim["verdict"] = "supported" if (not ours["blocked"] and sc_ok and chunks) else "unsupported"
    return claim


async def audit_item(rails, actions_mod, item: dict, budget: list[int]) -> dict:
    answers = []
    for ans in item["answers"]:
        chunks = [f'[{e["title"]}] {e["text"]}' for e in ans["evidence"]]
        claims = [await audit_sentence(rails, actions_mod, ans["question"], s, chunks, budget) for s in sentences(ans["draft"])]
        flagged = [c for c in claims if c["verdict"] != "no_claim_flagged"]
        answers.append({"answer_id": ans["answer_id"], "question_ref": ans["question_ref"], "evidence_chunks": len(chunks), "claims": claims,
                        "flagged": len(flagged), "unsupported": sum(c["verdict"] == "unsupported" for c in flagged)})
    return {"answers": answers, "flagged": sum(a["flagged"] for a in answers), "unsupported": sum(a["unsupported"] for a in answers)}


async def red_team(rails, actions_mod) -> dict:
    from redteam import RED_TEAM, RED_TEAM_EVIDENCE
    out = []
    for rt in RED_TEAM:
        c = await audit_sentence(rails, actions_mod, "Describe your company and certifications.", rt["text"], RED_TEAM_EVIDENCE, [0 if OFFLINE else 99])
        caught = c["verdict"] == "unsupported"
        out.append({"id": rt["id"], "attack": rt["attack"], "caught": caught,
                    "by_ours": not c.get("ours_claim_audit", {}).get("supported", True),
                    "by_nemo_self_check": c.get("nemo_self_check_facts", {}).get("supported") is False})
    caught = sum(o["caught"] for o in out)
    return {"total": len(out), "caught": caught, "rate": round(caught / len(out), 2), "prompts": out}


async def amain() -> int:
    import ours_actions as actions_mod
    t0 = time.time()
    rails = build_rails(os.path.join(HERE, "config"))
    queue = http("GET", f"/api/ingest/audit/queue?claim=1&job_id={JOB_ID}")["items"] if APP_URL else []
    print(f"queue: {len(queue)} audit(s)", flush=True)
    budget = [MAX_FLAGGED * max(len(queue), 1)]
    rt = await red_team(rails, actions_mod) if RED_TEAM_ON else None
    engine = {"nemo_guardrails": "0.24.1", "judge_model": JUDGE, "judge_endpoint": "api.tokenfactory.nebius.com",
              "labels": {"nemo.regex_output_rail": "NeMo library rail", "ours.claim_audit": "our custom NeMo action",
                         "nemo.self_check_facts": f"NeMo library rail, {JUDGE.split('/')[-1]} judge"}}
    for item in queue:
        status, result = "completed", None
        try:
            r = await audit_item(rails, actions_mod, item, budget)
            result = {"summary": {"answers": len(r["answers"]), "claims_flagged": r["flagged"], "claims_unsupported": r["unsupported"],
                                  "runtime_s": round(time.time() - t0, 1), "job_id": JOB_ID},
                      "engine": engine, "answers": r["answers"], "red_team": rt}
        except Exception as e:  # report, never swallow silently
            status, result = "failed", {"error": f"{type(e).__name__}: {e}"[:500], "engine": engine}
            print("audit failed:", result["error"], flush=True)
        http("POST", "/api/ingest/audit", {"audit_id": item["audit_id"], "status": status, "job_id": JOB_ID, "result": result})
        print(f"posted {item['audit_id']} {status}", flush=True)
    if not queue and rt and APP_URL:
        print("no queued audits; red team only:", json.dumps({k: rt[k] for k in ("total", "caught", "rate")}), flush=True)
    elif not APP_URL:
        print(json.dumps({"red_team": rt}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(amain()))
