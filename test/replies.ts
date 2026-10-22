// Replies for split, extract, skills and sessions. No live responses were captured for these routes yet.
// They follow the server code (wity-server engine/src/open_decision/skills_api.py, 22 Oct 2026),
// like the SDK's own tests do.

export const THREAD = "From: dana@example.com\nSeal test failed.\n\nFrom: marcus@example.com\nRerun tomorrow.";

export const splitReply = {
  items: [
    { start: 0, end: 40, text: THREAD.slice(0, 40) },
    { start: 42, end: THREAD.length, text: THREAD.slice(42) },
  ],
  how: "model",
  timing_ms: { total: 84 },
  usage: { input_tokens: 412, output_tokens: 0 },
};

export const extractReply = {
  fields: { party: ["Kestrel Foods Ltd.", "Brightmart Inc."], "effective date": ["2025-03-14"], court: [] },
  entities: [
    { field: "party", text: "Kestrel Foods Ltd.", start: 10, end: 28, confidence: 0.98 },
    { field: "party", text: "Brightmart Inc.", start: 34, end: 49, confidence: 0.9996 },
    { field: "effective date", text: "2025-03-14", start: 60, end: 74, confidence: 0.91 },
  ],
  timing_ms: 503,
  usage: { input_tokens: 301, output_tokens: 0 },
};

export const urgentSkill = {
  id: "sk_4f1c9e",
  object: "skill",
  kind: "decision",
  name: "urgent-ticket",
  description: "Tickets that need a reply within the hour",
  question: { type: "noul", instructions: "Does this ticket need a reply within the hour?" },
  parts: null,
  combine: null,
  metadata: {},
  examples: 12,
  status: "ready",
  answered_by: "examples",
  active: true,
  version: 3,
  quality: { accuracy: 0.92, accuracy_without_skill: 0.75, checked_on: 4 },
  created_at: 1792400000,
  updated_at: 1792400000,
};

export const emailSkill = {
  id: "sk_77aa01",
  object: "skill",
  kind: "split",
  name: "email-thread",
  description: "",
  split: { unit: "email", starts_at: ["a From: line"] },
  metadata: {},
  examples: 2,
  status: "ready",
  answered_by: "examples",
  active: true,
  version: 1,
  quality: null,
  created_at: 1792400000,
  updated_at: 1792400000,
};

export const skillList = { object: "list", data: [urgentSkill, emailSkill], has_more: false };

export const examplesReply = {
  object: "list",
  data: [
    {
      id: "ex_1",
      object: "skill.example",
      state: "Checkout is down for every customer.",
      answer: "yes",
      source: "api",
      created_at: 1792400000,
    },
  ],
  skill: { ...urgentSkill, examples: 13, status: "learning" },
  usage: { input_tokens: 40, output_tokens: 0 },
};

export const session = {
  id: "ses_9a41c0",
  object: "session",
  state: "Ticket #5120 from Northwind Foods.",
  skills: ["sk_4f1c9e"],
  metadata: {},
  events: 0,
  created_at: 1792400000,
  updated_at: 1792400000,
  expires_at: 1793004800,
};

/** A skill answer, as the session's skills give it. */
export const decision = {
  model: "wity-1",
  answers: {
    "urgent-ticket": {
      type: "noul",
      noul: 0.97,
      skill: { id: "sk_4f1c9e", name: "urgent-ticket", version: 3, answered_by: "examples", active: true },
    },
  },
  metadata: { reasoning: "off", elapsed_ms: 140 },
  usage: { input_tokens: 90, output_tokens: 0 },
  decision_id: "ev_3",
  session_id: "ses_9a41c0",
  context: { updates_read: 2, updates_left_out: 0 },
  cached: false,
};

export const eventLog = {
  object: "list",
  data: [
    {
      id: "ev_1",
      object: "session.event",
      type: "update",
      content: { content: "Customer: checkout still fails." },
      created_at: 1792400100,
    },
    {
      id: "ev_3",
      object: "session.event",
      type: "decision",
      content: {
        questions: { "urgent-ticket": { skill: "sk_4f1c9e" } },
        answers: decision.answers,
        rendered: "Earlier decision. Does this ticket need a reply within the hour? Answer: yes.",
        remember: false,
      },
      created_at: 1792400200,
    },
    {
      id: "ev_4",
      object: "session.event",
      type: "feedback",
      content: { decision_id: "ev_3", question: "urgent-ticket", answer: "no", skill: "sk_4f1c9e", example_id: "ex_9" },
      created_at: 1792400300,
    },
  ],
  has_more: false,
};

export const notFound = (what: string) => ({ status: 404, body: { error: what, code: "not_found" } });
