#!/bin/bash
set -e

# Build the app image (default) or the base image (--base).
#
# Usage:
#   ./build.sh                          # build app image (rs-agent-benchmark:latest)
#   ./build.sh --base                   # build base image (rs-agent-benchmark-base:latest)
#   PUSH=1 IMAGE_TAG=v26 ./build.sh     # build + push app image as v26
#   PUSH=1 IMAGE_TAG=v1 ./build.sh --base  # build + push base image as v1

BUILD_BASE=false
if [ "$1" = "--base" ]; then
    BUILD_BASE=true
    shift
fi

PLATFORM="${PLATFORM:-linux/amd64}"
cd "$(dirname "$0")"

if [ "$BUILD_BASE" = true ]; then
    IMAGE_NAME="${IMAGE_NAME:-ghcr.io/maxbittker/rs-agent-benchmark-base}"
    IMAGE_TAG="${IMAGE_TAG:-latest}"
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
    echo "Building BASE image: ${FULL_IMAGE} (platform: ${PLATFORM})"

    if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
        docker buildx build --platform "${PLATFORM}" -f Dockerfile.base -t "${FULL_IMAGE}" --push .
        echo "Built and pushed: ${FULL_IMAGE}"
    else
        docker buildx build --platform "${PLATFORM}" -f Dockerfile.base -t "${FULL_IMAGE}" --load .
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
    cp ../shared/agents.md agents.md

    if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
        docker buildx build --platform "${PLATFORM}" -t "${FULL_IMAGE}" --push .
        echo "Built and pushed: ${FULL_IMAGE}"
    else
        docker buildx build --platform "${PLATFORM}" -t "${FULL_IMAGE}" --load .
        echo "Built: ${FULL_IMAGE}"
    fi
fi
