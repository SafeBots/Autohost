#!/bin/bash
# Runs all tests, reports pass/fail.

set -e
cd "$(dirname "$0")/.."

TOTAL_PASS=0
TOTAL=0
FAILED_TESTS=()

for t in test/test*.js; do
    [ -f "$t" ] || continue
    result=$(timeout 30 node "$t" 2>&1 | tail -1)
    if [[ $result =~ ([0-9]+)/([0-9]+) ]]; then
        p=${BASH_REMATCH[1]}
        n=${BASH_REMATCH[2]}
        TOTAL_PASS=$((TOTAL_PASS + p))
        TOTAL=$((TOTAL + n))
        if [[ $p -ne $n ]]; then
            FAILED_TESTS+=("$t ($p/$n)")
        fi
        echo "  $(basename "$t"): $p/$n"
    else
        FAILED_TESTS+=("$t (no result)")
        echo "  $(basename "$t"): NO RESULT"
    fi
done

echo ""
echo "Total: $TOTAL_PASS / $TOTAL"
if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
    echo ""
    echo "FAILED:"
    for t in "${FAILED_TESTS[@]}"; do echo "  $t"; done
    exit 1
fi
exit 0
