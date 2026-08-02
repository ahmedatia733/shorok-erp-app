import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findForms, findPasswordFormsMissingPost } from "./password-form-safety";

describe("findForms", () => {
  it("reports a method-less form as such", () => {
    const [form] = findForms(`<form onSubmit={onSubmit}><input type="password" /></form>`);
    expect(form.hasMethod).toBe(false);
    expect(form.hasPasswordField).toBe(true);
  });

  it("recognises method='post'", () => {
    const [form] = findForms(`<form onSubmit={s} method="post"><input type="password" /></form>`);
    expect(form.hasMethod).toBe(true);
  });

  it("does not let a '>' inside an attribute value truncate the opening tag", () => {
    const [form] = findForms(
      `<form className="a>b" method="post" dir="rtl"><input type="password" /></form>`,
    );
    expect(form.hasMethod).toBe(true);
  });

  it("attributes a password field to the form that contains it, not a later one", () => {
    const forms = findForms(
      `<form onSubmit={a}><input type="text" /></form><form onSubmit={b}><input type="password" /></form>`,
    );
    expect(forms.map((f) => f.hasPasswordField)).toEqual([false, true]);
  });

  it("reports the line of the opening tag", () => {
    const [form] = findForms(`line one\nline two\n<form><input type="password" /></form>`);
    expect(form.line).toBe(3);
  });
});

describe("findPasswordFormsMissingPost", () => {
  it("flags a password form with no method", () => {
    expect(findPasswordFormsMissingPost(`<form><input type="password" /></form>`)).toHaveLength(1);
  });

  it("accepts a password form that posts", () => {
    expect(
      findPasswordFormsMissingPost(`<form method="post"><input type="password" /></form>`),
    ).toHaveLength(0);
  });

  it("ignores forms with no password field", () => {
    expect(findPasswordFormsMissingPost(`<form><input type="text" /></form>`)).toHaveLength(0);
  });
});

/**
 * The regression guard. This walks the real source tree, so a new password form
 * that omits method="post" fails here rather than in production.
 */
describe("no shipped form can leak a password into a URL", () => {
  const APP_ROOT = join(__dirname, "..");

  const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
      else if (entry.endsWith(".tsx")) out.push(path);
    }
    return out;
  };

  it("every form containing a password input sets method=\"post\"", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components"]) {
      for (const file of sourceFiles(join(APP_ROOT, dir))) {
        for (const form of findPasswordFormsMissingPost(readFileSync(file, "utf8"))) {
          offenders.push(`${file.replace(APP_ROOT + "/", "")}:${form.line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the login form posts and gates submission on hydration", () => {
    const source = readFileSync(
      join(APP_ROOT, "app/[locale]/(auth)/login/page.tsx"),
      "utf8",
    );
    // Both defences must remain: no pre-hydration submit, and no GET fallback.
    expect(source).toMatch(/<form[^>]*method="post"/);
    expect(source).toMatch(/disabled=\{submitting \|\| !hydrated\}/);
    expect(source).toMatch(/setHydrated\(true\)/);
  });

  it("the login form adopts input typed before hydration instead of dropping it", () => {
    const source = readFileSync(
      join(APP_ROOT, "app/[locale]/(auth)/login/page.tsx"),
      "utf8",
    );
    // Without this the controlled inputs submit empty strings and the user is
    // told their credentials are invalid while they are visible on screen.
    expect(source).toMatch(/formRef/);
    expect(source).toMatch(/elements\.namedItem/);
    expect(source).toMatch(/if \(typedPhone\) setPhone\(typedPhone\)/);
    expect(source).toMatch(/if \(typedPassword\) setPassword\(typedPassword\)/);
  });
});
