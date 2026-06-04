import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOutsideCwd } from "./path-guard";

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
