<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## SkillForge architecture
- All data comes from the external Express API via src/lib/api (fetch with credentials: 'include', base `${VITE_API_BASE_URL}/api/v1`); never store tokens in browser storage because auth is an HTTP-only cookie.
- Route guards (RequireRole) only hide UI; the API is the authority for access, grading, eligibility, and payment verification.
- Normalize backend documents in src/lib/api/models.ts so screens stay stable if response shapes shift.
- Use dedicated TanStack leaf routes for public content, student sections, learning, assessments, verification, and role workspaces so every view is directly navigable.
- Keep course fixtures and testable access/assessment rules in a browser-safe data module; shared UI and screen modules consume the same rules.
- Express the palette through semantic CSS tokens and use existing Button and Dialog controls for consistent accessible interactions.
