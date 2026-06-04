# Bowser Playwright Skill — Value Proposition

A concise, developer-friendly README for the Bowser Playwright skill used in this environment. It highlights token-efficient CLI usage, session persistence, headless-by-default operation with headed option, parallel sessions, vision mode optional, snapshot-driven interactions, and practical knobs for config. It also outlines typical use cases, safety and compliance considerations, and a quick-start usage snippet to onboard new contributors.

## What the Bowser Playwright skill is

- A browser automation capability built on Bowser (Playwright Bowser CLI) that enables headless or headed browser actions for UI testing, scraping, form automation, and data extraction. It emphasizes lightweight prompts, session-based workflows, and reliable element interactions through selectors and waits.

## Core capabilities
- Token-efficient CLI: commands and prompts are designed to minimize prompt length while delivering precise browser actions.
- Named session persistence: use -s <session-name> to isolate and reuse sessions across steps or tasks.
- Headless by default with headed option: runs headless by default; opt-in to visible UI for debugging or demos.
- Parallel sessions: run multiple named sessions in parallel to fetch data or test multiple pages concurrently.
- Vision mode (optional): optional visual targeting support for element detection when selectors are unstable.
- Snapshot-driven interaction: capture page states via snapshots to verify UI and assist debugging.
- Environment/config knobs: control viewport size and configuration via a config file.

## Environment and config knobs
- VIEWPORT or --viewport WIDTHxHEIGHT: set the browser viewport size (e.g., 1280x720).
- --config /path/to/config.json: load a JSON config with defaults, timeouts, and feature flags.
- HEADLESS / --headed: override default headless behavior to run with a visible UI.
- SESSION_NAME (-s): name sessions to enable parallelism and reuse cookies/state.
- VISION_MODE: enable or disable vision-based element targeting if supported by your Bowser build.

## Typical use cases
- UI testing and visual validation of web apps.
- Web scraping and data extraction from dynamic sites.
- Automation tasks like form filling, login flows, and data submission.
- Reusable browser-based workflows across multiple tasks via named sessions.

## Safety and compliance notes
- Respect terms of service and robots.txt; avoid scraping where prohibited.
- Implement rate limiting and backoff strategies to minimize impact on target sites.
- Avoid collecting or logging sensitive data (credentials, personal data) in prompts or logs.
- Run browser automation in isolated or sandboxed environments when possible.

## Quick-start usage snippet

```bash
# Start a headed session for debugging (optional)
bowser open https://example.com -s demo-session --headed

# Basic navigation and interaction in a named session
bowser navigate /login -s demo-session
bowser fill "#username" "demo-user" -s demo-session
bowser fill "#password" "s3cret" -s demo-session
bowser click "#login" -s demo-session

# Take a snapshot for verification (write under .playwright-cli/, not the project root)
bowser snapshot ".playwright-cli/login.png" -s demo-session

# Run headless by default for CI; override if needed
bowser close -s demo-session
```

## Quick onboarding summary

The Bowser Playwright skill provides a token-efficient CLI with named-session persistence and headless-by-default operation, enabling parallel browser tasks, optional vision-based targeting, and snapshot-driven interactions. By configuring a viewport and an optional config file, developers can build robust, browser-based automation for UI testing, scraping, and form automation while maintaining safety practices and compliance with site terms. This README serves as a ready reference to help new contributors quickly get started with Bowser-driven workflows in this environment.
