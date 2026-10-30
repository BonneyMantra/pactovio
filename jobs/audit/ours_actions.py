"""[OURS] claim_audit: a custom NeMo action (registered with @action) that checks each flagged claim
against that answer's evidence. Deterministic: every concrete value in a claim (ISO 27001, 64 staff, EUR 9.8M)
must be found in the evidence text. NeMo's own self check facts then adds the semantic LLM check."""
from typing import Optional

from nemoguardrails.actions import action

from claims import audit_claims

LAST_AUDIT: dict = {}  # filled per call; audit.py reads it to put our verdicts next to NeMo's


@action(name="claim_audit")
async def claim_audit(context: Optional[dict] = None, bot_message: Optional[str] = None) -> bool:
    context = context or {}
    text = bot_message if bot_message is not None else context.get("bot_message", "")
    chunks = context.get("relevant_chunks") or []
    evidence_text = "\n".join(chunks) if isinstance(chunks, list) else str(chunks)
    result = audit_claims(text, evidence_text)
    LAST_AUDIT[text] = result
    return result["supported"]
