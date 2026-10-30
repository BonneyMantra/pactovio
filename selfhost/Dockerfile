# Pactovio desk agent: Hermes Agent 0.15.1 + the event bridge, run inside an OpenShell sandbox.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HOME=/sandbox
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -d /sandbox -u 1000 -s /bin/bash sandbox
RUN python -m venv /opt/hermes \
 && /opt/hermes/bin/pip install "hermes-agent[mcp,slack]==0.15.1"
COPY hermes/ /sandbox/.hermes/profiles/pactovio/
COPY bridge/bridge.py /opt/pactovio/bridge.py
COPY bin/entrypoint.sh /opt/pactovio/entrypoint.sh
RUN chmod 0755 /opt/pactovio/entrypoint.sh \
 && mkdir -p /sandbox/state /sandbox/.hermes/profiles/pactovio/logs \
 && chown -R sandbox:sandbox /sandbox
ENV PATH=/opt/hermes/bin:$PATH HERMES_ACCEPT_HOOKS=1
USER sandbox
WORKDIR /sandbox
