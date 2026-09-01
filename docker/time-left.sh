#!/bin/bash
# time-left — how much of the task's time budget remains.
#
# The agent adapter writes the session's wall-clock deadline (unix seconds)
# to /tmp/task-deadline right before it launches the model session, so this
# works the same on a single sandbox and on a split-topology agent box.
#
#   time-left            # "37 minutes remaining (deadline 17:42 UTC)"
#   time-left --secs     # bare integer seconds remaining (0 when expired)
F=/tmp/task-deadline
if [ ! -s "$F" ]; then
    echo "time-left: no deadline recorded yet (/tmp/task-deadline missing)" >&2
    exit 1
fi
DEADLINE=$(tr -dc '0-9' < "$F")
NOW=$(date +%s)
LEFT=$((DEADLINE - NOW)); [ "$LEFT" -lt 0 ] && LEFT=0
if [ "$1" = "--secs" ]; then echo "$LEFT"; exit 0; fi
MIN=$((LEFT / 60)); SEC=$((LEFT % 60))
if [ "$LEFT" -eq 0 ]; then
    echo "0 minutes remaining — time is up (deadline $(date -u -d @"$DEADLINE" +%H:%M:%S) UTC)"
elif [ "$MIN" -lt 5 ]; then
    echo "$MIN min $SEC sec remaining (deadline $(date -u -d @"$DEADLINE" +%H:%M:%S) UTC)"
else
    echo "$MIN minutes remaining (deadline $(date -u -d @"$DEADLINE" +%H:%M) UTC)"
fi
