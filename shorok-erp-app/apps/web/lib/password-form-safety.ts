/**
 * Finds forms that could leak a password into a URL.
 *
 * Every form in this app is a client component that submits through React's
 * `onSubmit`. But the markup is server-rendered, so between first paint and
 * hydration the form is visible, clickable, and NOT yet wired to React. A
 * submission in that window is handled by the browser instead — and a `<form>`
 * with no `method` defaults to GET, which appends every field to the URL as a
 * query string.
 *
 * For a form carrying a password that means the plaintext credential ends up in
 * the address bar, in browser history, in the `Referer` header of subsequent
 * requests, and in the web server's HTTP access logs. This happened in
 * production on the login page.
 *
 * `method="post"` makes the pre-hydration fallback put the fields in a request
 * body instead. This module locates any password-bearing form still missing it,
 * so the test suite can fail before such a form ships again.
 */

/** A form element found in a source file, described by what the check needs. */
export interface FormOccurrence {
  /** 1-based line of the opening `<form` tag. */
  line: number;
  /** Whether the opening tag sets a `method` attribute. */
  hasMethod: boolean;
  /** Whether the form's body contains a password input. */
  hasPasswordField: boolean;
}

const FORM_OPEN = /<form(\s|>)/g;

/**
 * Extracts the opening tag starting at `from`, returning the tag text and the
 * index just past `>`. Quoted attribute values may contain `>`, so the scan
 * tracks quoting rather than searching for the next `>`.
 */
function readOpeningTag(source: string, from: number): { tag: string; end: number } {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return { tag: source.slice(from, i + 1), end: i + 1 };
  }
  return { tag: source.slice(from), end: source.length };
}

/**
 * Returns the region between a form's opening tag and its matching `</form>`,
 * accounting for nested forms even though the app has none today.
 */
function readFormBody(source: string, bodyStart: number): string {
  let depth = 1;
  let cursor = bodyStart;
  while (cursor < source.length && depth > 0) {
    const open = source.indexOf("<form", cursor);
    const close = source.indexOf("</form>", cursor);
    if (close === -1) return source.slice(bodyStart);
    if (open !== -1 && open < close) {
      depth += 1;
      cursor = open + 5;
      continue;
    }
    depth -= 1;
    if (depth === 0) return source.slice(bodyStart, close);
    cursor = close + 7;
  }
  return source.slice(bodyStart);
}

/** Every `<form>` in one source file, with the two properties the check needs. */
export function findForms(source: string): FormOccurrence[] {
  const forms: FormOccurrence[] = [];
  FORM_OPEN.lastIndex = 0;
  let match = FORM_OPEN.exec(source);
  while (match !== null) {
    const start = match.index;
    const { tag, end } = readOpeningTag(source, start);
    const body = readFormBody(source, end);
    forms.push({
      line: source.slice(0, start).split("\n").length,
      hasMethod: /\bmethod\s*=/.test(tag),
      hasPasswordField: /type\s*=\s*["'{]?\s*"?password/.test(body),
    });
    FORM_OPEN.lastIndex = end;
    match = FORM_OPEN.exec(source);
  }
  return forms;
}

/**
 * Forms that carry a password but would fall back to a GET submission.
 * A non-empty result is a credential-in-URL defect.
 */
export function findPasswordFormsMissingPost(source: string): FormOccurrence[] {
  return findForms(source).filter((f) => f.hasPasswordField && !f.hasMethod);
}
