#!/usr/bin/env bash
# Run every offline check in this repo.
set -e
cd "$(dirname "$0")/.."

echo "=== mailchimp tag sync ==="
node scripts/test_diff_tags.js
node scripts/validate_workflow.js
node scripts/simulate_tag_sync.js

echo
echo "=== j elliot weekly campaign report ==="
node scripts/test_weekly_report.js
node scripts/validate_weekly_report.js
