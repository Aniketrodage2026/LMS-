import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstructorAiDrafts } from "./instructor-ai-drafts";

vi.mock("@/lib/api/auth", () => ({
  useAuth: () => ({
    user: { id: "teacher-one", role: "INSTRUCTOR" },
    status: "authenticated",
    logout: vi.fn(),
  }),
}));

const courseId = "111111111111111111111111";
const materialId = "333333333333333333333333";
const response = {
  success: true,
  sourceMode: "PUBLISHED_MATERIALS",
  draft: {
    kind: "OUTLINE",
    title: "Variables lesson",
    items: [
      {
        heading: "Introduce variables",
        content: "Explain stored values.",
        citations: [{ materialId, title: "Published notes", pageStart: 1, pageEnd: 1 }],
      },
      {
        heading: "Trace assignments",
        content: "Trace a reassignment.",
        citations: [{ materialId, title: "Published notes", pageStart: 1, pageEnd: 1 }],
      },
      {
        heading: "Apply the idea",
        content: "Write a short example.",
        citations: [{ materialId, title: "Published notes", pageStart: 1, pageEnd: 1 }],
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("instructor AI drafts", () => {
  it("generates a course-scoped draft, supports transient edits, and does not save or publish it", async () => {
    const calls: Array<{
      path: string;
      method: string;
      body: unknown;
      credentials: RequestCredentials | undefined;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        calls.push({
          path: String(input).split("/api/v1")[1]!,
          method: init.method ?? "GET",
          body: JSON.parse(String(init.body)),
          credentials: init.credentials,
        });
        return new Response(JSON.stringify(response), { status: 200 });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InstructorAiDrafts courseId={courseId} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Topic or goal"), {
      target: { value: "Variables in JavaScript" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(await screen.findByRole("heading", { name: "Variables lesson" })).toBeInTheDocument();
    expect(screen.getAllByText("Published notes, pages 1-1")).toHaveLength(3);
    const content = screen.getByLabelText("Edit Introduce variables") as HTMLTextAreaElement;
    fireEvent.change(content, { target: { value: "Instructor-edited text." } });
    expect(content.value).toBe("Instructor-edited text.");
    fireEvent.change(screen.getByLabelText("Edit draft title"), {
      target: { value: "Reviewed title" },
    });
    expect(screen.getByLabelText("Edit draft title")).toHaveValue("Reviewed title");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      path: `/instructor/courses/${courseId}/ai-drafts`,
      method: "POST",
      body: { kind: "OUTLINE", focus: "Variables in JavaScript" },
      credentials: "include",
    });
    expect(screen.queryByRole("button", { name: /save|publish/i })).not.toBeInTheDocument();
    expect(calls.some((call) => /\/(save|publish)(\/|$)/i.test(call.path))).toBe(false);
    await act(async () => {
      client.clear();
    });
  });

  it("offers the metadata-only notice when no published excerpts are used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...response,
              sourceMode: "COURSE_METADATA_ONLY",
              draft: {
                ...response.draft,
                items: response.draft.items.map((item) => ({ ...item, citations: [] })),
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <InstructorAiDrafts courseId={courseId} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Topic or goal"), {
      target: { value: "Introductory concepts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    expect(
      await screen.findByText(/No published PDF excerpts were available/i),
    ).toBeInTheDocument();
    await act(async () => {
      client.clear();
    });
  });
});
