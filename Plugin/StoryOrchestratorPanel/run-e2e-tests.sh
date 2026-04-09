#!/bin/bash

# Playwright E2E Test Runner for StoryOrchestrator Panel

echo "Setting up Playwright tests..."

# Check if playwright is installed
if ! command -v npx &> /dev/null; then
    echo "Error: npx not found. Please install Node.js."
    exit 1
fi

# Install playwright if not already installed
if ! npx playwright --version &> /dev/null; then
    echo "Installing Playwright..."
    npm install -D @playwright/test
    npx playwright install chromium
fi

# Create test results directory
mkdir -p test-results

echo ""
echo "Running E2E tests..."
echo "===================="

# Run tests
npx playwright test --config=playwright.config.js "$@"

# Check results
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ All tests passed!"
    echo ""
    echo "Screenshots saved to: test-results/"
else
    echo ""
    echo "❌ Some tests failed."
    echo ""
    echo "View report: npx playwright show-report test-results/report"
fi
