#!/bin/bash

# Generate a zip file with files needed to run the script locally

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Check that dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Error: node_modules not found. Run 'npm install' first." >&2
  exit 1
fi

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
DEFAULT_ZIP_NAME="github-categorized-releases-${VERSION}.zip"

# Determine output path
if [ -n "$1" ]; then
  if [ -d "$1" ]; then
    # Argument is an existing directory, use default name in that directory
    ZIP_PATH="$1/$DEFAULT_ZIP_NAME"
  else
    # Argument is a file path
    ZIP_PATH="$1"
  fi
else
  # No argument, use default name in project directory
  ZIP_PATH="$PROJECT_DIR/$DEFAULT_ZIP_NAME"
fi

# Make path absolute if relative
if [[ "$ZIP_PATH" != /* ]]; then
  ZIP_PATH="$PROJECT_DIR/$ZIP_PATH"
fi

# Create a temporary directory for the release
TEMP_DIR=$(mktemp -d)
RELEASE_DIR="$TEMP_DIR/github-categorized-releases"
mkdir -p "$RELEASE_DIR"

# Copy required files
cp -r src "$RELEASE_DIR/"
cp -r node_modules "$RELEASE_DIR/"
cp "$SCRIPT_DIR/generate-release-zip-readme.txt" "$RELEASE_DIR/readme.txt"

# Remove the zip if it already exists
rm -f "$ZIP_PATH"

# Create the zip file
cd "$TEMP_DIR"
zip -r "$ZIP_PATH" "github-categorized-releases"

# Clean up
rm -rf "$TEMP_DIR"

echo "Created $ZIP_PATH"
