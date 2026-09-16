import test from "node:test";
import assert from "node:assert/strict";
import { parseSuggestedQuestions } from "../src/suggestedQuestionParser";

test("parseSuggestedQuestions extracts numbered HTML questions", () => {
  const html = `<h4>Suggested Questions (reply with the item number only):</h4>
<p>1. What are the 2026 benefits?</p>
<p>2. How do I enroll?</p>`;

  assert.deepEqual(parseSuggestedQuestions(html), [
    { title: "What are the 2026 benefits?", value: "What are the 2026 benefits?" },
    { title: "How do I enroll?", value: "How do I enroll?" }
  ]);
});

test("parseSuggestedQuestions ignores empty items and decodes HTML", () => {
  const html = `<h4>Suggested Questions (reply with the item number only):</h4>
<p>1. </p>
<p>2. How do I compare &amp; enroll?</p>`;

  assert.deepEqual(parseSuggestedQuestions(html), [
    { title: "How do I compare & enroll?", value: "How do I compare & enroll?" }
  ]);
});

test("parseSuggestedQuestions does not parse unrelated numbered paragraphs", () => {
  assert.deepEqual(parseSuggestedQuestions("<p>1. Not a suggestion</p>"), []);
});