#!/usr/bin/env bash
# Run every offline check for the Mailchimp tag sync.
set -e
cd "$(dirname "$0")/.."
node scripts/test_build_tag_ops.js
node scripts/validate_workflow.js
node scripts/simulate_tag_sync.js
