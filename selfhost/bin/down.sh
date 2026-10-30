#!/bin/sh
# Stop and remove the 'pactovio' sandbox and its two providers. Leaves the OpenShell gateway running (other tools may use it).
set -u
openshell sandbox delete pactovio 2>&1 | tail -1
openshell provider delete pactovio-nebius pactovio-api pactovio-slack 2>&1 | tail -2
