import { describe, expect, it } from "vitest";
import { parseReviewSummary, REVIEW_SUMMARY_SCHEMA, type ReviewSummary } from "../../src/review/review-summary.schemas.js";

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: ReviewSummary = {
    reviewers_spawned: ["correctness", "docs"],
    reviewers_returned: ["correctness", "docs"],
    review_mode: "full",
    incremental_from_sha: null,
    prior_importants: [],
    findings: [
      {
        file: "src/a.ts",
        line: "12-14",
        area: "correctness",
        confidence: "high",
        tag: "important",
        description: "Off-by-one in the pager.",
        body: "The loop stops one page early.",
        suggestion: null,
      },
    ],
    refuted_findings: [
      {
        file: null,
        line: null,
        area: "security",
        confidence: "medium",
        tag: "important",
        description: "Token logged.",
        refutation: "The logger redacts it.",
      },
    ],
    process_issues: [{ component: "validator", description: "One validator timed out." }],
  };
  return { ...base, ...overrides };
}

const parse = (value: unknown) => parseReviewSummary(JSON.stringify(value));

describe("review summary contract", () => {
  it("accepts a well-formed summary", () => {
    expect(parse(summary())).toHaveProperty("summary");
  });

  it("treats empty output as absent, not as a rejection", () => {
    expect(parseReviewSummary("  ")).toBeNull();
  });

  it("rejects output that is not JSON", () => {
    expect(parseReviewSummary("{not json")).toEqual({ rejected: "structured output was not valid JSON" });
  });

  it("rejects a missing required field", () => {
    const { findings: _dropped, ...rest } = summary();
    expect(parse(rest)).toEqual({ rejected: expect.stringContaining("$.findings: required") });
  });

  // Without the count a record cannot be told from one whose reviewers never reported.
  it("rejects a record that does not say which reviewers returned", () => {
    const { reviewers_returned: _dropped, ...rest } = summary();
    expect(parse(rest)).toEqual({ rejected: expect.stringContaining("$.reviewers_returned: required") });
  });

  it("rejects a value outside an enum", () => {
    const bad = summary({ review_mode: "partial" });
    expect(parse(bad)).toEqual({ rejected: expect.stringContaining("$.review_mode") });
  });

  // A refuted finding renders from description + refutation only; a body there would be
  // author-facing prose the poster never shows.
  it("rejects author-facing fields on a refuted finding", () => {
    const bad = summary({
      refuted_findings: [{ ...(summary().refuted_findings as object[])[0], body: "should not be here" }],
    });
    expect(parse(bad)).toEqual({ rejected: expect.stringContaining("$.refuted_findings[0].body: not allowed") });
  });

  it("accepts null where the contract is nullable and rejects it elsewhere", () => {
    expect(parse(summary({ incremental_from_sha: null }))).toHaveProperty("summary");
    expect(parse(summary({ review_mode: null }))).toHaveProperty("rejected");
  });

  it("is a bare schema object the action accepts", () => {
    expect(REVIEW_SUMMARY_SCHEMA).not.toHaveProperty("$schema");
    expect(REVIEW_SUMMARY_SCHEMA.type).toBe("object");
  });
});
