#!/bin/bash
set -e

# Build the app image (default) or the base image (--base).
#
# Usage:
#   ./build.sh                          # build app image (rs-agent-benchmark:latest)
#   ./build.sh --base                   # build base image (rs-agent-benchmark-base:latest)
#   PUSH=1 IMAGE_TAG=v26 ./build.sh     # build + push app image as v26
#   PUSH=1 IMAGE_TAG=v1 ./build.sh --base  # build + push base image as v1
#   NO_CACHE=1 ...                      # force full rebuild (e.g. fresh rs-sdk clone)

BUILD_BASE=false
if [ "$1" = "--base" ]; then
    BUILD_BASE=true
    shift
fi

PLATFORM="${PLATFORM:-linux/amd64}"
BUILD_FLAGS=""
if [ "${NO_CACHE:-0}" = "1" ]; then
    BUILD_FLAGS="--no-cache"
    echo "Cache disabled (NO_CACHE=1) — rs-sdk will be re-cloned fresh"
fi
cd "$(dirname "$0")"

if [ "$BUILD_BASE" = true ]; then
    IMAGE_NAME="${IMAGE_NAME:-ghcr.io/maxbittker/rs-agent-benchmark-base}"
    IMAGE_TAG="${IMAGE_TAG:-latest}"
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
    echo "Building BASE image: ${FULL_IMAGE} (platform: ${PLATFORM})"

    if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
        docker buildx build $BUILD_FLAGS --platform "${PLATFORM}" -f Dockerfile.base -t "${FULL_IMAGE}" --push .
        echo "Built and pushed: ${FULL_IMAGE}"
    else
        docker buildx build $BUILD_FLAGS --platform "${PLATFORM}" -f Dockerfile.base -t "${FULL_IMAGE}" --load .
        echo "Built: ${FULL_IMAGE}"
    fi
else
    IMAGE_NAME="${IMAGE_NAME:-ghcr.io/maxbittker/rs-agent-benchmark}"
    IMAGE_TAG="${IMAGE_TAG:-latest}"
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
    echo "Building APP image: ${FULL_IMAGE} (platform: ${PLATFORM})"

    # Copy shared scripts from shared/ (single source of truth)
    cp ../shared/skill_tracker.ts skill_tracker.ts
    cp ../shared/check_xp_rate.ts check_xp_rate.ts
    cp ../shared/save-parser.ts save-parser.ts
    cp ../shared/agents.md agents.md

    RS_SDK_REPO="${RS_SDK_REPO:-https://github.com/MaxBittker/rs-sdk.git}"
    RS_SDK_REF="${RS_SDK_REF:-main}"

    # rs-sdk source. Default: resolve the remote ref to a concrete SHA and pass
    # it as a cache-bust arg — the Dockerfile's `git clone --branch main` layer
    # is byte-identical between builds, so WITHOUT this Docker reuses the cached
    # clone and a freshly-tagged image ships the OLD sdk. (The Dockerfile also
    # hard-fails if the baked SHA doesn't match what was requested.)
    #
    # RS_SDK_LOCAL=/path/to/rs-sdk instead bakes that WORKING TREE (tracked
    # files + untracked-but-not-ignored, minus local junk) via the build
    # context — for testing uncommitted SDK changes. The commit stamp becomes
    # "<HEAD sha>-dirty".
    rm -rf rs-sdk-local && mkdir rs-sdk-local
    if [ -n "${RS_SDK_LOCAL:-}" ]; then
        echo "Staging LOCAL rs-sdk working tree from ${RS_SDK_LOCAL} ..."
        FILELIST="$(mktemp)"
        (
            cd "${RS_SDK_LOCAL}"
            git ls-files
            git ls-files --others --exclude-standard \
                | grep -v -E '^(bots/|diagram/|iron-trajectories\.zip|server/engine/db\.sqlite)'
        ) > "$FILELIST"
        rsync -a --files-from="$FILELIST" "${RS_SDK_LOCAL}/" rs-sdk-local/
        rm -f "$FILELIST"
        RS_SDK_COMMIT="$(git -C "${RS_SDK_LOCAL}" rev-parse HEAD)-dirty"
        echo "  rs-sdk local tree = ${RS_SDK_COMMIT} ($(du -sh rs-sdk-local | cut -f1) staged)"
    else
        touch rs-sdk-local/.keep
        echo "Resolving ${RS_SDK_REF} on ${RS_SDK_REPO} ..."
        RS_SDK_COMMIT="$(git ls-remote "${RS_SDK_REPO}" "${RS_SDK_REF}" | cut -f1)"
        if [ -z "$RS_SDK_COMMIT" ]; then
            echo "ERROR: could not resolve ${RS_SDK_REF} on ${RS_SDK_REPO}" >&2
            exit 1
        fi
        echo "  rs-sdk ${RS_SDK_REF} = ${RS_SDK_COMMIT}"
    fi

    if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
        docker buildx build --platform "${PLATFORM}" \
            --build-arg "RS_SDK_REPO=${RS_SDK_REPO}" \
            --build-arg "RS_SDK_REF=${RS_SDK_REF}" \
            --build-arg "RS_SDK_COMMIT=${RS_SDK_COMMIT}" \
            -t "${FULL_IMAGE}" --push .
        echo "Built and pushed: ${FULL_IMAGE} (rs-sdk ${RS_SDK_COMMIT})"
    else
        docker buildx build --platform "${PLATFORM}" \
            --build-arg "RS_SDK_REPO=${RS_SDK_REPO}" \
            --build-arg "RS_SDK_REF=${RS_SDK_REF}" \
            --build-arg "RS_SDK_COMMIT=${RS_SDK_COMMIT}" \
            -t "${FULL_IMAGE}" --load .
        echo "Built: ${FULL_IMAGE} (rs-sdk ${RS_SDK_COMMIT})"
    fi
fi
