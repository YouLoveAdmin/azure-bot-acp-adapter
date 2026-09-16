export type SuggestedQuestion = {
  title: string;
  value: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract numbered suggested questions from the response's HTML section. */
export function parseSuggestedQuestions(html: string): SuggestedQuestion[] {
  const headingMatch = html.match(/<h[1-6][^>]*>\s*Suggested Questions\b[^<]*<\/h[1-6]>/i);
  if (!headingMatch || headingMatch.index === undefined) {
    return [];
  }

  const afterHeading = html.slice(headingMatch.index + headingMatch[0].length);
  const section = afterHeading.split(/<h[1-6][^>]*>/i, 1)[0];
  const questions: SuggestedQuestion[] = [];

  for (const paragraph of section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = htmlToText(paragraph[1]);
    const questionMatch = text.match(/^\d+[.)]\s*(.+)$/);
    if (!questionMatch || questionMatch[1].trim().length === 0) {
      continue;
    }

    const question = questionMatch[1].trim();
    questions.push({ title: question, value: question });
  }

  return questions;
}