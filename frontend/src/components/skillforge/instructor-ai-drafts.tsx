import { useState, type FormEvent } from "react";
import { Copy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstructorAiDraft } from "@/lib/api/hooks";
import type { InstructorAiDraftKind, InstructorAiDraftReply } from "@/lib/api/models";
import { presentApiError } from "@/lib/errors/present";
import { ErrorGuidance, useErrorContext } from "./shared";

const kindLabels: Record<InstructorAiDraftKind, string> = {
  OUTLINE: "Course outline",
  PRACTICE_PROMPTS: "Practice prompts",
  ASSIGNMENT_RUBRIC: "Assignment rubric",
};

function draftText(draft: InstructorAiDraftReply) {
  return [
    draft.title,
    ...draft.items.flatMap((item) => [
      `${item.heading}\n${item.content}`,
      ...item.citations.map(
        (citation) => `Source: ${citation.title}, pages ${citation.pageStart}-${citation.pageEnd}`,
      ),
    ]),
  ].join("\n\n");
}

export function InstructorAiDrafts({ courseId }: { courseId: string }) {
  const generation = useInstructorAiDraft();
  const context = useErrorContext({ courseId });
  const [kind, setKind] = useState<InstructorAiDraftKind>("OUTLINE");
  const [focus, setFocus] = useState("");
  const [draft, setDraft] = useState<InstructorAiDraftReply | null>(null);
  const [validation, setValidation] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    generation.reset();
    setDraft(null);
    setNotice("");
    if (!focus.trim() || focus.trim().length > 300) {
      setValidation("Describe the topic or goal in 1 to 300 characters.");
      return;
    }
    setValidation("");
    try {
      setDraft(await generation.mutateAsync({ courseId, kind, focus }));
    } catch {
      // The mutation error is shown using the approved, code-based guidance below.
    }
  };

  const copyDraft = async () => {
    if (!draft || !navigator.clipboard?.writeText) {
      setNotice("Clipboard access is unavailable. You can select and copy the draft text.");
      return;
    }
    try {
      await navigator.clipboard.writeText(draftText(draft));
      setNotice("Draft copied. Review and edit it before using it in a course.");
    } catch {
      setNotice("Could not access the clipboard. You can select and copy the draft text.");
    }
  };

  const updateContent = (index: number, content: string) => {
    setDraft(
      (current) =>
        current && {
          ...current,
          items: current.items.map((item, itemIndex) =>
            itemIndex === index ? { ...item, content } : item,
          ),
        },
    );
  };
  const updateHeading = (index: number, heading: string) => {
    setDraft(
      (current) =>
        current && {
          ...current,
          items: current.items.map((item, itemIndex) =>
            itemIndex === index ? { ...item, heading } : item,
          ),
        },
    );
  };

  return (
    <div className="grid gap-6 mt-6">
      <section
        className="rounded-xl border bg-card p-5 sm:p-6"
        aria-labelledby="ai-draft-form-title"
      >
        <h2 id="ai-draft-form-title" className="text-lg flex gap-2 items-center">
          <Sparkles size={18} aria-hidden="true" />
          Create a course draft
        </h2>
        <p className="text-sm text-muted-foreground">
          Drafts use this course’s metadata and published PDF excerpts only. Review and edit
          everything; nothing is saved or published automatically.
        </p>
        <form onSubmit={submit}>
          <fieldset disabled={generation.isPending} className="grid gap-4 min-w-0">
            <label className="field">
              <span>Draft type</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as InstructorAiDraftKind)}
              >
                {Object.entries(kindLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Topic or goal</span>
              <textarea
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                maxLength={300}
                rows={3}
                placeholder="For example, introduce variables and assignment in JavaScript"
                required
              />
            </label>
            <Button type="submit" className="justify-self-start" disabled={generation.isPending}>
              {generation.isPending ? "Generating draft…" : "Generate draft"}
            </Button>
          </fieldset>
        </form>
      </section>
      {validation && <ErrorGuidance error={validation} />}
      {generation.error && (
        <ErrorGuidance
          error={presentApiError(generation.error, context)}
          onRetry={() => {
            void generation.mutate({ courseId, kind, focus });
          }}
        />
      )}
      {draft && (
        <section
          className="rounded-xl border bg-card p-5 sm:p-6 grid gap-4"
          aria-labelledby="ai-draft-result-title"
        >
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div>
              <h2 id="ai-draft-result-title" className="text-lg mb-1">
                {draft.title}
              </h2>
              <p className="text-sm text-muted-foreground mb-0">
                {draft.sourceMode === "PUBLISHED_MATERIALS"
                  ? "Based on published course materials. Check each citation against the source."
                  : "No published PDF excerpts were available; this draft uses course metadata only."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copyDraft();
              }}
            >
              <Copy aria-hidden="true" />
              Copy draft
            </Button>
          </div>
          <label className="field">
            <span>Edit draft title</span>
            <input
              aria-label="Edit draft title"
              value={draft.title}
              maxLength={120}
              onChange={(event) =>
                setDraft((current) => current && { ...current, title: event.target.value })
              }
            />
          </label>
          {draft.items.map((item, index) => (
            <article key={`${index}-${item.heading}`} className="grid gap-2 rounded-lg border p-4">
              <label className="field">
                <span>Edit section heading</span>
                <input
                  aria-label={`Edit heading ${index + 1}`}
                  value={item.heading}
                  maxLength={120}
                  onChange={(event) => updateHeading(index, event.target.value)}
                />
              </label>
              <label className="field">
                <span>Edit draft content</span>
                <textarea
                  aria-label={`Edit ${item.heading}`}
                  value={item.content}
                  maxLength={600}
                  rows={4}
                  onChange={(event) => updateContent(index, event.target.value)}
                />
              </label>
              {item.citations.length > 0 && (
                <ul className="text-sm text-muted-foreground mb-0">
                  {item.citations.map((citation) => (
                    <li key={`${citation.materialId}-${citation.pageStart}-${citation.pageEnd}`}>
                      {citation.title}, pages {citation.pageStart}-{citation.pageEnd}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          <p
            role="status"
            aria-live="polite"
            className={notice ? "text-sm text-success mb-0" : "sr-only"}
          >
            {notice}
          </p>
          <p className="text-xs text-muted-foreground mb-0">
            This draft is temporary. Save or publish content only through the existing course editor
            after your review.
          </p>
        </section>
      )}
    </div>
  );
}
