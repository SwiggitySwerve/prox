#!/bin/sh
# Mock curl for the job script contract test; output is confined to synthetic tmpfs files.
printf '%s\n' "$@" > "$JOB_TEST_ROOT/argv"
cat > "$JOB_TEST_ROOT/headers"
