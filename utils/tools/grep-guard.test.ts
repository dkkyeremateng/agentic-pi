import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { balanceGroups, unbalancedParens, MAX_PATTERN_CHARS } from "./grep-guard";

describe("unbalancedParens", () => {
    it("finds an unclosed group", () => {
        assert.deepEqual(unbalancedParens("func (.*Stop"), [5]);
    });

    it("finds a stray close", () => {
        assert.deepEqual(unbalancedParens("Stop)"), [4]);
    });

    it("sees nothing wrong with a balanced pattern", () => {
        assert.deepEqual(unbalancedParens("func (\\w+) Stop"), []);
        assert.deepEqual(unbalancedParens("(a|(b))"), []);
    });

    it("ignores parens that are already literal", () => {
        // \( pairs with nothing on purpose, and [()] is a set. Escaping either
        // would change a pattern that already works.
        assert.deepEqual(unbalancedParens("func \\(.*Stop"), []);
        assert.deepEqual(unbalancedParens("[()]+"), []);
        assert.deepEqual(unbalancedParens("[^)]*("), [5]);
    });
});

describe("balanceGroups", () => {
    // Every one of these is a real pattern from the sink, with the error rg
    // reported after pi wrapped it in (?: ... ).
    it("repairs a Go receiver", () => {
        assert.equal(balanceGroups("func (.*Stop"), "func \\(.*Stop");
        assert.equal(balanceGroups("func (.* Close"), "func \\(.* Close");
    });

    it("repairs a call site", () => {
        assert.equal(balanceGroups("Publish("), "Publish\\(");
        assert.equal(balanceGroups("ConfirmDeposit("), "ConfirmDeposit\\(");
    });

    it("repairs an alternation with a receiver inside it", () => {
        assert.equal(
            balanceGroups("type HttpRequest|func (.*Send|WithContext|NewHttpRequest"),
            "type HttpRequest|func \\(.*Send|WithContext|NewHttpRequest",
        );
    });

    it("leaves a working pattern alone", () => {
        // The load-bearing guarantee: a deliberate group must survive untouched,
        // or this trades 13 broken searches for an unknown number of wrong ones.
        assert.equal(balanceGroups("func (\\w+) Stop"), null);
        assert.equal(balanceGroups("(?:a|b)+"), null);
        assert.equal(balanceGroups("SelectPendingDeposits"), null);
        assert.equal(balanceGroups(""), null);
    });

    it("declines when the parens were not the problem", () => {
        // A different breakage. Escaping parens would swap one error for
        // another, which costs the same turn and explains less.
        assert.equal(balanceGroups("a{2,1}(b)"), null);
        assert.equal(balanceGroups("[z-a](b)"), null);
    });

    it("declines on a pattern too long to be a real search", () => {
        assert.equal(balanceGroups("(".repeat(MAX_PATTERN_CHARS + 1)), null);
    });

    it("escapes every unpaired paren, not just the first", () => {
        assert.equal(balanceGroups("a(b(c"), "a\\(b\\(c");
        assert.equal(balanceGroups("a)b)c"), "a\\)b\\)c");
    });

    it("keeps the balanced groups while fixing the unbalanced ones", () => {
        const out = balanceGroups("(?:go|rust) func (.*Stop");
        assert.equal(out, "(?:go|rust) func \\(.*Stop");
        // And the result is a regex that actually runs.
        assert.ok(new RegExp(out as string).test("go func (xStop"));
    });
});
