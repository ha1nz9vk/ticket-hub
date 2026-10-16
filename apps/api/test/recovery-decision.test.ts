import assert from "node:assert/strict";
import { test } from "node:test";

import { decideRecovery } from "../src/jobs/recovery-decision";

test("Waiting job must not be recovered", () => {
  assert.equal(decideRecovery("waiting", 0, 3), "WAIT");
});

test("Active job must not be recovered", () => {
  assert.equal(decideRecovery("active", 1, 3), "WAIT");
});

test("Delayed retry job must wait", () => {
  assert.equal(decideRecovery("delayed", 1, 3), "WAIT");
});

test("Failed job before max attempts requires review", () => {
  assert.equal(decideRecovery("failed", 1, 3), "MANUAL_REVIEW");
});

test("Failed job after 3 attempts can be marked FAILED", () => {
  assert.equal(decideRecovery("failed", 3, 3), "MARK_FAILED");
});

test("Completed job with stuck Outbox requires review", () => {
  assert.equal(decideRecovery("completed", 3, 3), "MANUAL_REVIEW");
});

test("Missing job requires manual review", () => {
  assert.equal(decideRecovery("missing", 0, 1), "MANUAL_REVIEW");
});

test("Invalid max attempts cannot mark FAILED", () => {
  assert.equal(decideRecovery("failed", 3, 0), "MANUAL_REVIEW");
});
