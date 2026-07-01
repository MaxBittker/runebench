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

    # Resolve the rs-sdk commit being built so a new commit busts the clone
    # layer's cache automatically (NO_CACHE=1 no longer needed for that).
    RS_SDK_REPO="${RS_SDK_REPO:-https://github.com/MaxBittker/rs-sdk.git}"
    RS_SDK_REF="${RS_SDK_REF:-main}"
    RS_SDK_COMMIT=$(git ls-remote "$RS_SDK_REPO" "$RS_SDK_REF" | cut -f1)
    echo "Building against rs-sdk ${RS_SDK_REF} @ ${RS_SDK_COMMIT}"
    BUILD_FLAGS="$BUILD_FLAGS --build-arg RS_SDK_COMMIT=${RS_SDK_COMMIT}"

    if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
        docker buildx build $BUILD_FLAGS --platform "${PLATFORM}" -t "${FULL_IMAGE}" --push .
        echo "Built and pushed: ${FULL_IMAGE}"
    else
        docker buildx build $BUILD_FLAGS --platform "${PLATFORM}" -t "${FULL_IMAGE}" --load .
        echo "Built: ${FULL_IMAGE}"
    fi
fi
