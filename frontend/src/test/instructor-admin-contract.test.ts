import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { paiseToInrInput, toPaiseExact } from '@/lib/api/models';

const source = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
const instructorPages = source('../components/skillforge/instructor-pages.tsx');
const adminPages = source('../components/skillforge/admin-pages.tsx');

describe('instructor and admin API contracts', () => {
  it('maps server quiz prompts into local question state and sends prompt payloads', () => {
    expect(instructorPages).toContain('question: q.prompt ?? q.question ?? q.text ?? \'\'');
    expect(instructorPages).toContain('prompt: q.question');
    expect(instructorPages).not.toContain('questions: qs.map(q => ({ ...q');
  });

  it('uses the exact server review action payloads', () => {
    expect(instructorPages).toContain("{ action: 'GRADE', marks: Number(marks), feedback }");
    expect(instructorPages).toContain("{ action: 'REQUEST_RESUBMISSION', feedback }");
    expect(instructorPages).not.toContain("body: { status, feedback");
  });

  it('keeps assignment content and status changes as separate mutations', () => {
    expect(instructorPages).toContain("const content = { title: String(f.get('title') ?? '')");
    expect(instructorPages).toContain('if (!assignmentId || contentChanged)');
    expect(instructorPages).toContain("body: { status }");
    expect(instructorPages).not.toContain("maxMarks: Number(f.get('maxMarks')), status: f.get('status')");
  });

  it('sends only supported course fields and preserves paise precisely', () => {
    expect(instructorPages).toContain("const courseFields = ['title', 'description', 'category', 'accessType', 'price']");
    expect(instructorPages).toContain('toPaiseExact(String(input.get(\'price\') ?? \'\'))');
    expect(instructorPages).toContain("defaultValue={c && !c.isFree ? paiseToInrInput(c.price) : '1499'}");
    expect(instructorPages).not.toContain('name="level"');
    expect(instructorPages).not.toContain('name="previewLecture"');
    expect(instructorPages).not.toContain("f.set('isFree'");
  });

  it('round-trips sub-rupee paise without rounding', () => {
    expect(paiseToInrInput(99950)).toBe('999.50');
    expect(toPaiseExact('999.50')).toBe(99950);
  });

  it('does not offer an ADMIN role assignment while preserving admin workspace routing', () => {
    expect(adminPages).not.toContain('<option value="ADMIN">Admin</option>');
    expect(adminPages).toContain('<Workspace role="ADMIN">');
  });

  it('describes the instructor list as the public published course list only', () => {
    expect(instructorPages).toContain('Public published courses you teach. Draft courses are not returned by this list.');
    expect(instructorPages).not.toContain('Drafts appear here once the API lists them.');
  });
});
