"""[OURS] Claim extraction and evidence matching used by the claim_audit action and by audit.py."""
import re
from pathlib import Path

import yaml

CONFIG = Path(__file__).parent / "config" / "config.yml"


def _patterns() -> list[re.Pattern]:
    cfg = yaml.safe_load(CONFIG.read_text())
    return [re.compile(p, re.IGNORECASE) for p in cfg["rails"]["config"]["regex_detection"]["output"]["patterns"]]


PATTERNS = _patterns()


def claim_type(pattern: str) -> str:
    m = re.search(r"\(\?P<(\w+)>", pattern)
    return m.group(1) if m else "other"


def extract(text: str) -> list[dict]:
    """Every flagged claim value in `text`, with its type."""
    out = []
    for rx in PATTERNS:
        ctype = claim_type(rx.pattern)
        for m in rx.finditer(text):
            out.append({"type": ctype, "value": m.group(0).strip()})
    return out


def norm(s: str) -> str:
    s = s.lower().replace("‑", "-").replace("–", "-")
    s = re.sub(r"(\d),(\d{3})", r"\1\2", s)          # 5,950,000 -> 5950000
    s = re.sub(r"\bmillion\b", "m", s)
    s = re.sub(r"\b(?:eur|euros?)\b", "€", s)
    s = re.sub(r"[\s\-_/]+", "", s)
    return s


def _money_variants(value: str) -> list[str]:
    n = norm(value)
    return [n, n.replace("€", ""), n.replace("€", "").replace("$", "").replace("£", "")]


def value_supported(value: str, evidence_norm: str) -> bool:
    return any(v and v in evidence_norm for v in _money_variants(value))


def audit_claims(text: str, evidence: str) -> dict:
    """supported = every extracted claim value appears in the evidence."""
    ev = norm(evidence)
    claims = extract(text)
    unsupported = [c for c in claims if not value_supported(c["value"], ev)]
    return {
        "supported": not unsupported,
        "checked": claims,
        "unsupported": unsupported,
        "evidence_empty": not evidence.strip(),
    }
