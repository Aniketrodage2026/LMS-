import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

describe('backend paise display contract', () => {
  it('keeps backend paise intact until the shared INR formatter renders it', () => {
    const studentPages = source('../components/skillforge/student-pages.tsx');
    const publicPages = source('../components/skillforge/public-pages.tsx');
    const instructorPages = source('../components/skillforge/instructor-pages.tsx');

    expect(studentPages).not.toContain('amt > 10000');
    expect(studentPages).not.toContain('const rupees');
    expect(publicPages).toContain('useState(toPaise(5000))');
    expect(publicPages).not.toContain('accessAction');
    expect(instructorPages).toContain("toPaiseExact(String(input.get('price') ?? ''))");
    expect(instructorPages).toContain('paiseToInrInput(c.price)');
  });
});
