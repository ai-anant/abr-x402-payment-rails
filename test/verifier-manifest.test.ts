import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANTHROPIC_API_KEY_CLASS,
  AWS_STS_IDENTITY_CLASS,
  OPENAI_API_KEY_CLASS,
  VERIFIER_MANIFEST_SCHEMA_VERSION,
  parseEligibleCount,
  parseManifestRequest,
} from "../src/verifier-manifest.js";
import { DEMO_BUNDLE_PREFIX, buildDemoManifest } from "../src/demo-manifest.js";

describe("verifier manifest", () => {
  it("requires an explicit bounded billable check count", () => {
    assert.equal(parseEligibleCount("1"), 1);
    assert.equal(parseEligibleCount("5"), 5);
    for (const value of [undefined, "0", "26", "1.5", "01", ["1", "2"]]) {
      assert.throws(() => parseEligibleCount(value), /count/i);
    }
  });

  it("accepts supported single-class and multi-class count shapes", () => {
    assert.deepEqual(parseManifestRequest({ class: AWS_STS_IDENTITY_CLASS, count: "2" }), {
      checks: { [AWS_STS_IDENTITY_CLASS]: 2 },
      totalCount: 2,
      verifierClasses: [AWS_STS_IDENTITY_CLASS],
    });
    assert.deepEqual(
      parseManifestRequest({
        checks: `${AWS_STS_IDENTITY_CLASS}:2,${OPENAI_API_KEY_CLASS}:1,${ANTHROPIC_API_KEY_CLASS}:1`,
      }),
      {
        checks: {
          [AWS_STS_IDENTITY_CLASS]: 2,
          [OPENAI_API_KEY_CLASS]: 1,
          [ANTHROPIC_API_KEY_CLASS]: 1,
        },
        totalCount: 4,
        verifierClasses: [AWS_STS_IDENTITY_CLASS, OPENAI_API_KEY_CLASS, ANTHROPIC_API_KEY_CLASS],
      },
    );
    assert.throws(() => parseManifestRequest({ class: "github-token", count: "1" }), /class/i);
    assert.throws(
      () => parseManifestRequest({ class: AWS_STS_IDENTITY_CLASS, count: "1", profile: "default" }),
      /unexpected/i,
    );
    assert.throws(
      () => parseManifestRequest({ checks: `${OPENAI_API_KEY_CLASS}:1`, class: AWS_STS_IDENTITY_CLASS, count: "1" }),
      /mixed/i,
    );
  });

  it("the demo builder is labelled, harmless and schema-shaped", () => {
    const classes = [AWS_STS_IDENTITY_CLASS, OPENAI_API_KEY_CLASS, ANTHROPIC_API_KEY_CLASS] as const;
    const manifest = buildDemoManifest([...classes]);
    assert.equal(manifest.schema_version, VERIFIER_MANIFEST_SCHEMA_VERSION);
    assert.ok(manifest.bundle_id.startsWith(DEMO_BUNDLE_PREFIX));
    assert.deepEqual(manifest.verifier_classes, [...classes]);
    assert.equal(manifest.commands.length, classes.length);
    for (const command of manifest.commands) {
      assert.equal(command.command, "node");
      assert.match(command.args.join(" "), /demo: true/);
      assert.deepEqual(command.env, {});
    }
    assert.doesNotMatch(JSON.stringify(manifest), /aws sts|api\.openai\.com|api\.anthropic\.com|secret_value/);
  });
});
