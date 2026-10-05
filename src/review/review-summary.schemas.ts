/**
 * The review's structured-output contract. `REVIEW_SUMMARY_SCHEMA` is what the model is held to
 * through claude-code-action's `--json-schema`, and the same object validates the output the
 * poster and the metrics step read, so the contract and its check cannot drift apart.
 *
 * By design the summary is not a companion to the PR comments, it is the source they are
 * rendered from: the poster is the only writer, so anything the author must read has to travel
 * through a finding.
 */

export const REVIEWER_AREAS = ["correctness", "security", "conventions", "context", "maintainability", "docs"] as const;

export type ReviewerArea = (typeof REVIEWER_AREAS)[number];

export type Finding = {
  file: string | null;
  line: string | null;
  area: ReviewerArea;
  confidence: "high" | "medium";
  tag: "important" | "nit" | "pre-existing";
  description: string;
  body: string | null;
  suggestion: string | null;
};

export type RefutedFinding = Omit<Finding, "body" | "suggestion"> & { refutation: string };

export type ReviewSummary = {
  reviewers_spawned: ReviewerArea[];
  reviewers_returned: ReviewerArea[];
  review_mode: "full" | "incremental";
  incremental_from_sha: string | null;
  prior_importants: { file: string | null; line: string | null; status: "resolved" | "unresolved" }[];
  findings: Finding[];
  refuted_findings: RefutedFinding[];
  process_issues: { component: string; description: string }[];
};

export type Tokens = {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  total: number | null;
};

/** The normalised run record appended to `ci/review-metrics`, read by `review-retro`. */
export type MetricsRecord = {
  schema_version: number;
  timestamp: string;
  repository: string | null;
  run_id: string | null;
  run_url: string | null;
  actor: string | null;
  commit_sha: string | null;
  source: "pr";
  pr_number: number | null;
  action: "review";
  reviewers_spawned: ReviewerArea[];
  reviewers_returned: ReviewerArea[];
  reviewers_skipped: ReviewerArea[];
  review_mode: "full" | "incremental";
  incremental_from_sha: string | null;
  prior_importants: ReviewSummary["prior_importants"] | null;
  findings: Finding[] | null;
  refuted_findings: RefutedFinding[] | null;
  process_issues: ReviewSummary["process_issues"] | null;
  comments_posted_actual: number | null;
  is_error: boolean;
  /** Why the round is no verdict on the diff; it also sets `is_error`. Null when the record is a verdict. */
  incomplete_reason: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  num_turns: number | null;
  tokens: Tokens | null;
};

// Generated once with zod's toJSONSchema from the template's zod source, then frozen here so the
// scaffolder carries no runtime dependency. Only the keywords `matches` implements may appear.
export const REVIEW_SUMMARY_SCHEMA: JsonSchema = {
  "type": "object",
  "properties": {
    "reviewers_spawned": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "correctness",
          "security",
          "conventions",
          "context",
          "maintainability",
          "docs"
        ]
      },
      "description": "One entry per instance; an area repeats when several ran."
    },
    "reviewers_returned": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "correctness",
          "security",
          "conventions",
          "context",
          "maintainability",
          "docs"
        ]
      },
      "description": "One entry per instance whose report you received and consolidated, by area as in reviewers_spawned. Emit the record only once this equals reviewers_spawned: any shortfall is posted as an incomplete review, never as a clean one."
    },
    "review_mode": {
      "type": "string",
      "enum": [
        "full",
        "incremental"
      ],
      "description": "full reviews the PR diff; incremental reviews the delta since the prior review."
    },
    "incremental_from_sha": {
      "description": "The prior review's head SHA the delta ran from; null on a full review.",
      "type": [
        "string",
        "null"
      ]
    },
    "prior_importants": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": {
            "description": "Repo-relative file path from the prior record.",
            "type": [
              "string",
              "null"
            ]
          },
          "line": {
            "description": "Line number or range from the prior record.",
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "resolved",
              "unresolved"
            ],
            "description": "Whether the current head resolves the prior finding."
          }
        },
        "required": [
          "file",
          "line",
          "status"
        ],
        "additionalProperties": false
      },
      "description": "Incremental only: the prior record's important findings checked against the current head. Empty on full."
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": {
            "description": "Repo-relative file path.",
            "type": [
              "string",
              "null"
            ]
          },
          "line": {
            "description": "Line number or range.",
            "type": [
              "string",
              "null"
            ]
          },
          "area": {
            "type": "string",
            "enum": [
              "correctness",
              "security",
              "conventions",
              "context",
              "maintainability",
              "docs"
            ],
            "description": "Reviewer area that raised it."
          },
          "confidence": {
            "type": "string",
            "enum": [
              "high",
              "medium"
            ]
          },
          "tag": {
            "type": "string",
            "enum": [
              "important",
              "nit",
              "pre-existing"
            ]
          },
          "description": {
            "type": "string",
            "description": "One-line description of the issue. On nit and pre-existing findings this is the line the author reads in the review body's collapsed sections, so write it for a person, not a trend column."
          },
          "body": {
            "description": "Markdown the PR author reads: the concern, the rule or code it cites, and a link. Required on important findings, which are the only ones posted; null on nit and pre-existing. Falls back to description when null.",
            "type": [
              "string",
              "null"
            ]
          },
          "suggestion": {
            "description": "Replacement code for the flagged lines, posted as a committable suggestion block. Only for a small self-contained fix that resolves the finding entirely; null otherwise.",
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "file",
          "line",
          "area",
          "confidence",
          "tag",
          "description",
          "body",
          "suggestion"
        ],
        "additionalProperties": false
      },
      "description": "The confirmed findings the run acted on."
    },
    "refuted_findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": {
            "description": "Repo-relative file path.",
            "type": [
              "string",
              "null"
            ]
          },
          "line": {
            "description": "Line number or range.",
            "type": [
              "string",
              "null"
            ]
          },
          "area": {
            "type": "string",
            "enum": [
              "correctness",
              "security",
              "conventions",
              "context",
              "maintainability",
              "docs"
            ],
            "description": "Reviewer area that raised it."
          },
          "confidence": {
            "type": "string",
            "enum": [
              "high",
              "medium"
            ]
          },
          "tag": {
            "type": "string",
            "enum": [
              "important",
              "nit",
              "pre-existing"
            ]
          },
          "description": {
            "type": "string",
            "description": "One-line description of the issue. On nit and pre-existing findings this is the line the author reads in the review body's collapsed sections, so write it for a person, not a trend column."
          },
          "refutation": {
            "type": "string",
            "description": "Why validation refuted the finding, grounded in the code."
          }
        },
        "required": [
          "file",
          "line",
          "area",
          "confidence",
          "tag",
          "description",
          "refutation"
        ],
        "additionalProperties": false
      },
      "description": "Important findings validation refuted and dropped; sub-important findings are not validated."
    },
    "process_issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "component": {
            "type": "string",
            "enum": [
              "correctness",
              "security",
              "conventions",
              "context",
              "maintainability",
              "docs",
              "consolidator",
              "validator",
              "orchestrator",
              "platform"
            ],
            "description": "The pipeline part that misbehaved; platform covers failures outside any agent."
          },
          "description": {
            "type": "string",
            "description": "What went wrong, with specifics that help debugging."
          }
        },
        "required": [
          "component",
          "description"
        ],
        "additionalProperties": false
      },
      "description": "Problems in the review process itself, not the code. Empty when it ran clean."
    }
  },
  "required": [
    "reviewers_spawned",
    "reviewers_returned",
    "review_mode",
    "incremental_from_sha",
    "prior_importants",
    "findings",
    "refuted_findings",
    "process_issues"
  ],
  "additionalProperties": false
};

export type JsonSchema = {
  type?: string | string[];
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  description?: string;
};

/** The first violation of `schema` in `value`, as a JSON-pointer-ish path, or null when it conforms. */
export function schemaViolation(schema: JsonSchema, value: unknown, at = "$"): string | null {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => hasType(value, type))) return `${at}: expected ${allowed.join(" | ")}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
    return `${at}: expected one of ${schema.enum.join(", ")}`;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const violation = schemaViolation(schema.items, item, `${at}[${index}]`);
      if (violation) return violation;
    }
  }
  if (isObject(value) && schema.properties !== undefined) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${at}.${key}: required`;
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) return `${at}.${key}: not allowed`;
        continue;
      }
      const violation = schemaViolation(property, item, `${at}.${key}`);
      if (violation) return violation;
    }
  }
  return null;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isObject(value);
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the model's raw structured output; the reason it was rejected otherwise. */
export function parseReviewSummary(raw: string): { summary: ReviewSummary } | { rejected: string } | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: "structured output was not valid JSON" };
  }
  const violation = schemaViolation(REVIEW_SUMMARY_SCHEMA, parsed);
  if (violation) return { rejected: `structured output did not match the schema: ${violation}` };
  return { summary: parsed as ReviewSummary };
}
