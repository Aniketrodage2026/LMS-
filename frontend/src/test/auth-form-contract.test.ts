import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("authentication form contracts", () => {
  it("submits fullName for registration and profile updates", () => {
    const authPages = source("../components/skillforge/auth-pages.tsx");
    const studentPages = source("../components/skillforge/student-pages.tsx");

    expect(authPages).toContain('<input name="fullName" autoComplete="name" required />');
    expect(studentPages).toContain('<input name="fullName" required defaultValue={user.name} />');
    expect(studentPages).toContain("name: String(f.get('fullName'))");
    expect(authPages).not.toContain('<input name="name" autoComplete="name" required />');
    expect(studentPages).not.toContain('<input name="name" required defaultValue={user.name} />');
    expect(studentPages).not.toContain("f.get('name')");
  });
});
