import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOutsideCwd, isWithinAny, defaultSkillRoots } from "./path-guard";

describe("isOutsideCwd", () => {
    const cwd = "/home/user/project";

    it("allows paths inside the cwd", () => {
        assert.equal(isOutsideCwd(cwd, "src/app.ts"), false);
        assert.equal(isOutsideCwd(cwd, "./README.md"), false);
        assert.equal(isOutsideCwd(cwd, "a/b/c.txt"), false);
        assert.equal(isOutsideCwd(cwd, "."), false);
        assert.equal(isOutsideCwd(cwd, "/home/user/project/src/x.ts"), false);
    });

    it("blocks parent-traversal and sibling escapes", () => {
        assert.equal(isOutsideCwd(cwd, "../secret.txt"), true);
        assert.equal(isOutsideCwd(cwd, "src/../../etc/passwd"), true);
        assert.equal(isOutsideCwd(cwd, "../other-project/file.ts"), true);
    });

    it("blocks absolute paths outside the cwd", () => {
        assert.equal(isOutsideCwd(cwd, "/etc/passwd"), true);
        assert.equal(isOutsideCwd(cwd, "/home/user/elsewhere"), true);
    });

    it("is empty-safe", () => {
        assert.equal(isOutsideCwd(cwd, ""), false);
    });
});

describe("isWithinAny", () => {
    const cwd = "/home/user/project";
    const skills = "/opt/pi/skills";

    it("allows paths inside the cwd", () => {
        assert.equal(isWithinAny([cwd, skills], "src/app.ts"), true);
        assert.equal(isWithinAny([cwd, skills], "/home/user/project/x.ts"), true);
    });

    it("allows paths inside an extra trusted root (skills dir)", () => {
        assert.equal(isWithinAny([cwd, skills], "/opt/pi/skills/playwright-cli/SKILL.md"), true);
    });

    it("blocks paths outside every root", () => {
        assert.equal(isWithinAny([cwd, skills], "/etc/passwd"), false);
        assert.equal(isWithinAny([cwd, skills], "../secret.txt"), false);
    });

    it("ignores falsy roots", () => {
        assert.equal(isWithinAny([cwd, undefined], "src/app.ts"), true);
        assert.equal(isWithinAny([undefined], "/anything"), false);
    });
});

describe("defaultSkillRoots covers package-provided skills", () => {
    // The root that was missing. `pi install npm:<pkg>` puts skills at
    // <agentDir>/npm/node_modules/<pkg>/skills/<name>/SKILL.md, and pi advertises
    // them to every agent WITH that path -- so without this root an agent follows
    // the instruction it was given and we block it. Seen live on
    // run-mte9oayl-nlqlm: three refused reads of pi-context's context-management.
    const agentDir = join(homedir(), ".pi", "agent");
    const roots = () => defaultSkillRoots("/repo/skills");

    it("admits a skill inside an installed package", () => {
        const p = join(agentDir, "npm", "node_modules", "pi-context", "skills",
            "context-management", "SKILL.md");
        assert.equal(isWithinAny(roots(), p), true);
    });

    it("still admits the bundled and global skill dirs", () => {
        assert.equal(isWithinAny(roots(), "/repo/skills/lsp/SKILL.md"), true);
        assert.equal(
            isWithinAny(roots(), join(agentDir, "skills", "ai-agent-builder", "SKILL.md")),
            true,
        );
    });

    it("still refuses paths outside every root", () => {
        // The guard's actual job is unchanged: another project stays off limits.
        assert.equal(isWithinAny(roots(), join(homedir(), "Documents", "other", "x.ts")), false);
        assert.equal(isWithinAny(roots(), "/etc/passwd"), false);
    });
});
