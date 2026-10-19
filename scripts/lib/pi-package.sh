# pi-package.sh — find the pi that `pi` on PATH actually runs. Sourced, not run.
#
# pi ships in two layouts, and the repo has to follow both:
#   - npm global: `pi` is a symlink to <pkg>/dist/bundle/cli.js inside the
#     package, so resolving the link and walking up finds the package.json.
#   - managed (the pi.dev installer, which `pi update` migrates to since 1.0.1):
#     `pi` is ~/.pi/agent/bin/pi, a SHELL SCRIPT that reads
#     install/current-version and execs install/releases/<v>/node_modules/.bin/pi.
#     Walking up from the script finds no package.json at all — pi 1.3.0's
#     migration is how run.sh's version check started killing the launcher.
#
# bash 3.2-safe (macOS): no mapfile, no associative arrays.

# Real path of the JS entry the `pi` on PATH runs; non-zero when there is no pi.
pi_entry() {
    local bin agent_dir ver
    bin="$(command -v pi 2>/dev/null)" || return 1
    bin="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
    agent_dir="$(dirname "$(dirname "$bin")")"
    if [ -f "$agent_dir/install/current-version" ] &&
        grep -q 'PI_MANAGED_INSTALL_ROOT' "$bin" 2>/dev/null; then
        IFS= read -r ver < "$agent_dir/install/current-version" || return 1
        bin="$agent_dir/install/releases/$ver/node_modules/.bin/pi"
        [ -e "$bin" ] || return 1
    fi
    readlink -f "$bin" 2>/dev/null || echo "$bin"
}

# Root of the @earendil-works/pi-coding-agent package behind `pi`. Walks up from
# the entry rather than assuming its depth: 0.84.3 moved it to dist/bundle/.
pi_package_dir() {
    local dir
    dir="$(pi_entry)" || return 1
    dir="$(dirname "$dir")"
    while [ "$dir" != "/" ] && [ -n "$dir" ]; do
        if [ -f "$dir/package.json" ] &&
            grep -q '"name": *"@earendil-works/pi-coding-agent"' "$dir/package.json"; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

# Version string from that package.json.
pi_package_version() {
    local dir
    dir="$(pi_package_dir)" || return 1
    sed -n 's/^[[:space:]]*"version": *"\([^"]*\)".*/\1/p' "$dir/package.json" | head -1
}

# A dependency of pi's package: nested under it (npm global) or beside it in the
# same node_modules (managed install). Prints the path; non-zero when absent.
pi_dependency_dir() {
    local pkg="$1" name="$2" d
    for d in "$pkg/node_modules/$name" "$(dirname "$(dirname "$pkg")")/$name"; do
        if [ -e "$d" ]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}
