#!/bin/bash
# Run the market benchmark: each run is ONE model controlling all bots
# (k miners / k smiths / k alchemists, k=2 by default → 6 bots) via
# concurrent OpenCode sessions (opencode_team_adapter). Every bot scores
# INDIVIDUALLY on its final gold (inventory + bank coins at the end of the
# run); harbor reward = the total across all bots.
#
# Usage:
#   run-market.sh                 # all models, 20m, 2 per role
#   run-market.sh -m gemini37flash
#   run-market.sh -k 4            # 4 trials per model
#   run-market.sh -n 4            # 4 per role = 12 bots (market-<H>-n12 task)
#   run-market.sh --split -H 60m -n 4 --mix grok46,gemini37flash
#                                 # ONE mixed-model run: within every role the
#                                 # listed models are dealt evenly and in a
#                                 # RANDOM order over the role's bots (bot
#                                 # names reveal nothing; the mapping lands in
#                                 # the job's logs as bot-models.json)
#   run-market.sh --rank          # -rank task variant: agents get a
#                                 # market-status CLI (time left + live wealth
#                                 # rank from the watcher's RANK_PORT endpoint)
#   run-market.sh --collective --mix m1,m2 [--leader-model opus5]
#                                 # collective-market task variant: one smith
#                                 # (the middle one; identity NOT in the public
#                                 # brief) is a GUILD LEADER scored on the
#                                 # smiths' COMBINED final coins, not its own.
#                                 # The leader runs --leader-model (default
#                                 # opus5); the rest are dealt from --mix.
#                                 # Requires --mix (use --mix <one model> for a
#                                 # homogeneous field).
#   run-market.sh --dry-run       # print harbor commands without launching
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/run-common.sh"

HORIZON="20m"

# The market task is a fixed "k of every role" layout. Bots are named
# <first>_<role> (anna_miner, cara_smith, ella_alch): first names (one per
# letter a..z) are dealt role by role alphabetically (k=2: anna/ben miners,
# cara/dan smiths, ella/finn alchemists; k=4: a-d / e-h / i-l; k=6: a-f / g-l /
# m-r; k=8: a-h / i-p / q-x) — must match MARKET_BOT_POOL / MARKET_ROLE_SUFFIX /
# marketBotRoles in generate-tasks.ts. bot_names overrides the adapter's
# derived agenta..N.
PER_ROLE=2
MARKET_BOT_POOL="anna ben cara dan ella finn gus hana ivy jack kim leo mia ned otto pam quinn ray sam tess uma vic wes xena yara zed"
MARKET_ROLE_SUFFIX="miner smith alch"

# ── Defaults ──────────────────────────────────────────────────────
SELECTED_MODELS=""
MIX_MODELS=""
K_TRIALS=1
SPLIT=0
RANK=0
COLLECTIVE=0
LEADER_MODEL="opus5"
DRY_RUN=0
EXTRA_ARGS=""

# ── Parse args ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)     SELECTED_MODELS="$SELECTED_MODELS $2"; shift 2 ;;
    --mix)          MIX_MODELS="$(echo "$2" | tr ',' ' ')"; shift 2 ;;
    -k|--k-trials)  K_TRIALS="$2"; shift 2 ;;
    -H|--horizon)   HORIZON="$2"; shift 2 ;;
    -n|--per-role)  PER_ROLE="$2"; shift 2 ;;
    --split)       SPLIT=1; shift ;;
    --rank)        RANK=1; shift ;;
    --collective)  COLLECTIVE=1; shift ;;
    --leader-model) LEADER_MODEL="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: run-market.sh [-m model] [--mix m1,m2] [-k trials] [-H horizon] [-n per_role] [--split] [--rank] [--dry-run]"
      echo ""
      echo "Models: $ALL_MODEL_LABELS (default: all)"
      echo ""
      echo "Each trial runs one model as ALL players of the market challenge"
      echo "(k miners / k smiths / k alchemists, -n k, default 2). Every player"
      echo "scores individually on final gold; reward = total across bots."
      echo "--mix m1,m2[,...] runs ONE trial with the listed models dealt"
      echo "evenly + randomly within every role (k must be a multiple of the"
      echo "model count)."
      echo "--rank picks the -rank task variant: agents get a market-status"
      echo "CLI showing time left + their live wealth rank."
      echo "--collective picks the collective-market variant: one smith is a"
      echo "guild leader (model: --leader-model, default opus5) scored on the"
      echo "smiths' combined final coins. Requires --mix."
      exit 0
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
  esac
done

TEAM_SIZE=$((PER_ROLE * 3))
if [ "$(echo $MARKET_BOT_POOL | wc -w | tr -d ' ')" -lt "$TEAM_SIZE" ]; then
  echo "-n $PER_ROLE needs $TEAM_SIZE bots but MARKET_BOT_POOL only has $(echo $MARKET_BOT_POOL | wc -w | tr -d ' ')" >&2
  exit 1
fi
MARKET_BOTS=$(
  i=0
  for suffix in $MARKET_ROLE_SUFFIX; do
    for first in $(echo $MARKET_BOT_POOL | tr ' ' '\n' | tail -n +$((i + 1)) | head -n "$PER_ROLE"); do
      echo "${first}_${suffix}"
    done
    i=$((i + PER_ROLE))
  done | paste -sd, -
)
SIZE_SUFFIX=""
[ "$PER_ROLE" != "2" ] && SIZE_SUFFIX="-n${TEAM_SIZE}"

if [ -n "$MIX_MODELS" ] && [ -n "$SELECTED_MODELS" ]; then
  echo "--mix and -m are mutually exclusive" >&2
  exit 1
fi
if [ -z "$MIX_MODELS" ] && [ -z "$SELECTED_MODELS" ]; then
  SELECTED_MODELS="$ALL_MODEL_LABELS"
fi

# --rank: the -rank task variant ships the market-status CLI (time left +
# live wealth rank served by the watcher's RANK_PORT endpoint).
RANK_SUFFIX=""
[ "$RANK" = "1" ] && RANK_SUFFIX="-rank"

# --collective: the collective-market variant — the MIDDLE smith (must match
# marketGuildLeader in generate-tasks.ts: smiths[floor(perRole/2)]) is a guild
# leader scored on the smiths' combined final coins. The leader's session gets
# its private goal via --ak guild_leader; its model is pinned to LEADER_MODEL
# on top of the --mix deal.
COLLECTIVE_PREFIX=""
COLLECTIVE_FLAGS=""
LEADER_BOT=""
if [ "$COLLECTIVE" = "1" ]; then
  if [ -z "$MIX_MODELS" ]; then
    echo "--collective requires --mix (use --mix <one model> for a homogeneous field)" >&2
    exit 1
  fi
  COLLECTIVE_PREFIX="collective-"
  LEADER_FIRST=$(echo $MARKET_BOT_POOL | tr ' ' '\n' | sed -n "$((PER_ROLE + PER_ROLE / 2 + 1))p")
  LEADER_BOT="${LEADER_FIRST}_smith"
  COLLECTIVE_FLAGS="--ak guild_leader=$LEADER_BOT"
fi

# --split: 1 Modal sandbox per agent + 1 server-only sandbox (opencode_split_adapter).
apply_split_mode 0
TASK="${COLLECTIVE_PREFIX}market-${HORIZON}${SIZE_SUFFIX}${RANK_SUFFIX}${SPLIT_SUFFIX}"
SANDBOX_TIMEOUT=$(sandbox_timeout_for_horizon "$HORIZON")
RUN_TIMEOUT=$(run_timeout_for_horizon "$HORIZON")

load_env "$REPO_ROOT/.env"

# SKIP_REGEN=1 lets a caller that launches several invocations in parallel
# regenerate tasks/ once up front (the regen wipes tasks/ and would race).
if [ "$DRY_RUN" != "1" ] && [ "${SKIP_REGEN:-0}" != "1" ]; then
  regenerate_tasks "$REPO_ROOT/generate-tasks.ts"
fi

# ── Pick the adapter for one model label (sets AGENT_FLAG; 1 = skip) ──
market_agent_flag() {
  local agent="$1"
  # Every model runs through a team adapter for this task (one session per
  # bot). NOTE: models whose adapter carries _model_options (reasoning effort
  # etc.) need their OWN team subclass — the generic team adapter drops them.
  case "$agent" in
    luna-xhigh-opencode) AGENT_FLAG="--agent-import-path 'luna_adapter:LunaXhighTeamAdapter'" ;;
    muse12-opencode) AGENT_FLAG="--agent-import-path 'muse12_adapter:Muse12TeamAdapter'" ;;
    *opencode*) AGENT_FLAG="--agent-import-path 'opencode_team_adapter:OpenCodeTeamAdapter'" ;;
  esac
  # Split topology only has the generic opencode adapter so far.
  if [ "$SPLIT" = "1" ]; then
    case "$agent" in
      *opencode*) AGENT_FLAG="--agent-import-path 'opencode_split_adapter:OpenCodeSplitTeamAdapter'" ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

# ── Mixed-model run: build the per-bot model map + merged creds ──
# Sets MIX_BOT_MODELS (a=<id>,b=<id>,...), MIX_MODEL_IDS, MIX_ENV_FLAGS,
# MIX_EXTRA_ARGS, MIX_MODEL_OPTIONS (per-model opencode options, see
# team_model_options in run-common.sh), MIX_LABEL. Within each role the model list is repeated
# PER_ROLE/len times and shuffled, so which letter got which model is random
# and unguessable from the name (recorded in the job's bot-models.json).
build_mix() {
  local n_mix
  n_mix=$(echo $MIX_MODELS | wc -w | tr -d ' ')
  if [ $((PER_ROLE % n_mix)) -ne 0 ]; then
    echo "--mix has $n_mix models but -n $PER_ROLE per role isn't a multiple of that" >&2
    exit 1
  fi
  MIX_MODEL_IDS=""; MIX_ENV_FLAGS=""; MIX_EXTRA_ARGS=""; MIX_LABEL=""; MIX_MODEL_OPTIONS=""
  local m entry agent model label
  for m in $MIX_MODELS; do
    entry=$(lookup_model "$m" "$ALL_MODELS")
    if [ -z "$entry" ]; then
      echo "Unknown model: $m (available: $ALL_MODEL_LABELS)"; exit 1
    fi
    IFS='|' read -r agent model label <<< "$entry"
    if ! configure_model_env "$m" "$REPO_ROOT/agents" "$entry"; then
      echo "Missing credentials for $m — aborting mixed run" >&2; exit 1
    fi
    if ! market_agent_flag "$agent"; then
      echo "$m is not an opencode-family model — --mix needs the generic team/split adapter" >&2; exit 1
    fi
    case "$AGENT_ENV_FLAGS" in
      "") ;;
      *) case " $MIX_ENV_FLAGS " in *" $AGENT_ENV_FLAGS "*) ;; *) MIX_ENV_FLAGS="$MIX_ENV_FLAGS $AGENT_ENV_FLAGS" ;; esac ;;
    esac
    team_model_extra_args "$m"
    case "$MODEL_EXTRA_ARGS" in
      "") ;;
      *) case " $MIX_EXTRA_ARGS " in *" $MODEL_EXTRA_ARGS "*) ;; *) MIX_EXTRA_ARGS="$MIX_EXTRA_ARGS $MODEL_EXTRA_ARGS" ;; esac ;;
    esac
    team_model_options "$m"
    [ -n "$MODEL_OPTIONS_SPEC" ] && MIX_MODEL_OPTIONS="${MIX_MODEL_OPTIONS:+$MIX_MODEL_OPTIONS;}$MODEL_OPTIONS_SPEC"
    MIX_MODEL_IDS="$MIX_MODEL_IDS $model"
    MIX_LABEL="${MIX_LABEL:+$MIX_LABEL+}$label"
  done
  # Deal + shuffle per role (bun for a portable RNG; macOS has no shuf).
  MIX_BOT_MODELS=$(bun -e '
    const bots = process.argv[1].split(",");
    const models = process.argv[2].trim().split(/\s+/);
    const perRole = Number(process.argv[3]);
    const out = [];
    for (let r = 0; r < bots.length; r += perRole) {
      const deck = [];
      for (let i = 0; i < perRole / models.length; i++) deck.push(...models);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      bots.slice(r, r + perRole).forEach((b, i) => out.push(`${b}=${deck[i]}`));
    }
    console.log(out.join(","));
  ' "$MARKET_BOTS" "$MIX_MODEL_IDS" "$PER_ROLE")

  # --collective: pin the guild leader's session to LEADER_MODEL on top of the
  # deal (creds/options/regions merged like any mix member; the leader model is
  # NOT part of the per-role deck, so the other smiths keep the mix).
  if [ "$COLLECTIVE" = "1" ]; then
    entry=$(lookup_model "$LEADER_MODEL" "$ALL_MODELS")
    if [ -z "$entry" ]; then
      echo "Unknown leader model: $LEADER_MODEL (available: $ALL_MODEL_LABELS)"; exit 1
    fi
    IFS='|' read -r agent model label <<< "$entry"
    if ! configure_model_env "$LEADER_MODEL" "$REPO_ROOT/agents" "$entry"; then
      echo "Missing credentials for leader model $LEADER_MODEL — aborting" >&2; exit 1
    fi
    if ! market_agent_flag "$agent"; then
      echo "$LEADER_MODEL is not an opencode-family model — the leader runs through the generic team/split adapter" >&2; exit 1
    fi
    case "$AGENT_ENV_FLAGS" in
      "") ;;
      *) case " $MIX_ENV_FLAGS " in *" $AGENT_ENV_FLAGS "*) ;; *) MIX_ENV_FLAGS="$MIX_ENV_FLAGS $AGENT_ENV_FLAGS" ;; esac ;;
    esac
    team_model_extra_args "$LEADER_MODEL"
    case "$MODEL_EXTRA_ARGS" in
      "") ;;
      *) case " $MIX_EXTRA_ARGS " in *" $MODEL_EXTRA_ARGS "*) ;; *) MIX_EXTRA_ARGS="$MIX_EXTRA_ARGS $MODEL_EXTRA_ARGS" ;; esac ;;
    esac
    team_model_options "$LEADER_MODEL"
    [ -n "$MODEL_OPTIONS_SPEC" ] && MIX_MODEL_OPTIONS="${MIX_MODEL_OPTIONS:+$MIX_MODEL_OPTIONS;}$MODEL_OPTIONS_SPEC"
    MIX_BOT_MODELS=$(echo "$MIX_BOT_MODELS" | sed "s|${LEADER_BOT}=[^,]*|${LEADER_BOT}=${model}|")
    MIX_LABEL="${MIX_LABEL}+ldr-${label}"
  fi
}

# ── Launch all models in parallel (one sandbox each, like run.sh) ──
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PIDS=""
LAUNCHED=""

if [ -n "$MIX_MODELS" ]; then
  build_mix
  # -m names the run's nominal model (first in the mix); each bot's real
  # model comes from --ak bot_models.
  NOMINAL_MODEL=$(echo $MIX_MODEL_IDS | awk '{print $1}')
  # AGENT_FLAG/ENV_PREFIX are left over from the last configure_model_env +
  # market_agent_flag call in build_mix — same generic adapter for all.
  RUNS="mix"
else
  RUNS="$SELECTED_MODELS"
fi

for model_name in $RUNS; do
  if [ "$model_name" = "mix" ]; then
    model="$NOMINAL_MODEL"
    label="mix-${MIX_LABEL}"
    AGENT_ENV_FLAGS="$MIX_ENV_FLAGS"
    MODEL_EXTRA_ARGS="$MIX_EXTRA_ARGS"
    BOT_MODELS_FLAG="--ak bot_models=$MIX_BOT_MODELS"
    [ -n "$MIX_MODEL_OPTIONS" ] && BOT_MODELS_FLAG="$BOT_MODELS_FLAG --ak 'model_options=$MIX_MODEL_OPTIONS'"
  else
    entry=$(lookup_model "$model_name" "$ALL_MODELS")
    if [ -z "$entry" ]; then
      echo "Unknown model: $model_name (available: $ALL_MODEL_LABELS)"
      exit 1
    fi
    IFS='|' read -r agent model label <<< "$entry"
    if ! configure_model_env "$model_name" "$REPO_ROOT/agents" "$entry"; then
      continue
    fi
    if ! market_agent_flag "$agent"; then
      echo "  Skipping $model_name: --split only supports opencode-family agents"
      continue
    fi
    team_model_extra_args "$model_name"
    BOT_MODELS_FLAG=""
  fi

  JOB_NAME="${COLLECTIVE_PREFIX}market${SPLIT_TAG}${SIZE_SUFFIX}${RANK_SUFFIX}-${label}-${TIMESTAMP}"
  LOG_FILE="/tmp/harbor-${JOB_NAME}.log"

  CMD="$ENV_PREFIX harbor run \
    -p '$REPO_ROOT/tasks/$TASK' \
    $AGENT_FLAG \
    -m '$model' \
    --job-name '$JOB_NAME' \
    --env modal \
    --ek sandbox_timeout_secs=$SANDBOX_TIMEOUT \
    --ak run_timeout_sec=$RUN_TIMEOUT \
    --ak team_size=$TEAM_SIZE \
    --ak bot_names=$MARKET_BOTS \
    $BOT_MODELS_FLAG \
    $COLLECTIVE_FLAGS \
    $SPLIT_FLAGS \
    $AGENT_ENV_FLAGS \
    -n 4 \
    -k $K_TRIALS \
    $EXTRA_ARGS $MODEL_EXTRA_ARGS"

  if [ "$DRY_RUN" = "1" ]; then
    echo "── $model_name ──"
    [ -n "$BOT_MODELS_FLAG" ] && echo "bot → model: $MIX_BOT_MODELS"
    [ "$COLLECTIVE" = "1" ] && echo "guild leader: $LEADER_BOT ($LEADER_MODEL)"
    echo "$CMD"
    echo ""
    continue
  fi

  echo "  Launching $model_name (market × $K_TRIALS trial(s)) → $LOG_FILE"
  [ -n "$BOT_MODELS_FLAG" ] && echo "  bot → model: $MIX_BOT_MODELS"
  [ "$COLLECTIVE" = "1" ] && echo "  guild leader: $LEADER_BOT ($LEADER_MODEL)"
  eval "$CMD" > "$LOG_FILE" 2>&1 &
  PIDS="$PIDS $!"
  LAUNCHED="$LAUNCHED $model_name"
done

if [ "$DRY_RUN" = "1" ]; then
  exit 0
fi

echo ""
echo "All models launched in parallel. Waiting for completion..."

FAILED=0
TOTAL=0
for pid in $PIDS; do
  TOTAL=$((TOTAL + 1))
  if ! wait "$pid"; then
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
  echo "All market runs complete. ($TOTAL models:$LAUNCHED)"
else
  echo "All runs finished. $FAILED of $TOTAL model(s) had errors."
fi
