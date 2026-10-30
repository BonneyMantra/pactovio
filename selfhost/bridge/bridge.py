#!/usr/bin/env python3
"""Pactovio desk-agent bridge.

Outbound only: opens GET {PACTOVIO_APP_URL}/v1/agent/events (SSE, API key), and hands every proactive
event to the Hermes agent, which summarises it and asks the person to confirm through its gateway (Slack).
No inbound port, no tunnel. Resumes from the last seen event id after a restart or a Mac sleep.

Env: PACTOVIO_APP_URL, PACTOVIO_API_KEY, HERMES_PROFILE (default pactovio), BRIDGE_STATE (default /sandbox/state),
     BRIDGE_DRY_RUN=1 (print the prompt instead of calling Hermes).
Usage: bridge.py            run forever
       bridge.py --replay F handle the events in JSON file F once (no network), for tests
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

APP = os.environ.get("PACTOVIO_APP_URL", "http://host.openshell.internal:8798").rstrip("/")
KEY = os.environ.get("PACTOVIO_API_KEY", "")
PROFILE = os.environ.get("HERMES_PROFILE", "pactovio")
STATE = os.environ.get("BRIDGE_STATE", "/sandbox/state")
DRY = os.environ.get("BRIDGE_DRY_RUN") == "1"
HERMES_TIMEOUT = int(os.environ.get("BRIDGE_HERMES_TIMEOUT", "240"))


def log(**kw):
    kw["t"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = json.dumps(kw)
    print(line, file=sys.stderr, flush=True)
    try:
        with open(os.path.join(STATE, "bridge.log"), "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def read_last_id():
    try:
        return open(os.path.join(STATE, "last-event-id")).read().strip() or None
    except OSError:
        return None


def write_last_id(i):
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(os.path.join(STATE, "last-event-id"), "w") as f:
            f.write(i)
    except OSError:
        log(level="warn", msg="cannot persist last event id")


def parse_sse(lines):
    """Yield (event, id, data) from an iterable of text lines (SSE framing)."""
    ev, eid, data = "message", None, []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield ev, eid, "\n".join(data)
            ev, data = "message", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            ev = value
        elif field == "id":
            eid = value
        elif field == "data":
            data.append(value)


def build_prompt(payload):
    m = payload.get("message") or {}
    kind = payload.get("event_type") or m.get("event_type") or "event"
    text = (m.get("content") or "").strip()
    action = m.get("action_id")
    return (
        f"Pactovio proactive event: {kind}.\n"
        f"Message from the hosted agent: {text}\n"
        + (f"It carries a pending action id: {action}. Do NOT confirm it yourself.\n" if action else "")
        + "Use the pactovio tools if you need detail (read-only). Then tell the person in two or three sentences what "
        "happened, what you recommend, and ask them to confirm or decline. If the Slack send_message tool is available, "
        "send that to the home channel; otherwise just answer here. Never claim Slack is connected unless a send_message call succeeded."
    )


def handoff(payload):
    prompt = build_prompt(payload)
    if DRY:
        log(level="info", msg="dry-run prompt", prompt=prompt)
        return 0
    cmd = ["/opt/hermes/bin/hermes", "-p", PROFILE, "chat", "-Q", "-q", prompt, "--max-turns", "6"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=HERMES_TIMEOUT)
        log(level="info", msg="hermes handled event", rc=r.returncode, reply=(r.stdout or "")[-1200:], err=(r.stderr or "")[-300:])
        return r.returncode
    except subprocess.TimeoutExpired:
        log(level="error", msg="hermes timed out")
        return 124


def handle(event, eid, data):
    if event == "reconnect":
        return False
    if event != "message":
        return True
    try:
        payload = json.loads(data)
    except ValueError:
        log(level="warn", msg="unparseable event", id=eid)
        return True
    handoff(payload)
    if eid:
        write_last_id(eid)
    return True


def stream_once(last_id):
    req = urllib.request.Request(APP + "/v1/agent/events", headers={
        "Authorization": f"Bearer {KEY}", "Accept": "text/event-stream", "Cache-Control": "no-cache",
        **({"Last-Event-ID": last_id} if last_id else {}),
    })
    with urllib.request.urlopen(req, timeout=90) as resp:
        log(level="info", msg="connected", status=resp.status, since=last_id)
        for ev, eid, data in parse_sse(line.decode("utf-8", "replace") for line in resp):
            if not handle(ev, eid, data):
                return


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--replay":
        for i, p in enumerate(json.load(open(sys.argv[2]))):
            handle("message", f"replay-{i}", json.dumps(p))
        return
    delay = 3
    while True:
        try:
            stream_once(read_last_id())
            delay = 3
        except urllib.error.HTTPError as e:
            log(level="error", msg="http error", status=e.code)
            delay = min(delay * 2, 120)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log(level="warn", msg="stream dropped", kind=type(e).__name__)
            delay = min(delay * 2, 120)
        time.sleep(delay)


if __name__ == "__main__":
    main()
