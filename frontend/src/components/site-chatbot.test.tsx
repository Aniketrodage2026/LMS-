import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteChatbot } from "./site-chatbot";
import { COURSE_TUTOR_HANDOFF_EVENT, requestCourseTutorHandoff } from "@/lib/course-tutor-handoff";

const authState = vi.hoisted(() => ({
  user: null as null | { id: string; role: "STUDENT" },
  status: "guest" as "guest" | "authenticated",
}));
const activeCourse = {
  course: { id: "444444444444444444444444", title: "Learning React", category: "Web" },
  progress: { totalLectures: 2, completedLectures: 1, completionPercent: 50 },
  lastActivityAt: null,
  activityStatus: "NOT_STARTED" as const,
  nextLecture: { id: "555555555555555555555555", title: "Components" },
  assessments: { totalQuizzes: 0, totalAssignments: 0, quizzes: [], assignments: [] },
  certificate: null,
};

vi.mock("@/lib/api/auth", () => ({ useAuth: () => authState }));

const clients: QueryClient[] = [];
type ApiRequest = { path: string; init: RequestInit; body: Record<string, unknown> | undefined };
function mount(server: (request: ApiRequest) => unknown = () => undefined) {
  const requests: ApiRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const body = init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      const request = { path: String(input).split("/api/v1")[1]!, init, body };
      requests.push(request);
      const response =
        server(request) ??
        (request.path === "/ai/guidance"
          ? {
              success: true,
              guidance: {
                activeCourses: [activeCourse],
                recap: { courseCount: 1, completedLessons: 1, totalLessons: 2, upcomingWork: [] },
              },
            }
          : {
              success: true,
              chatbot: { message: "Start with small, reusable components.", citations: [] },
            });
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <SiteChatbot />
    </QueryClientProvider>
  );
  const rendered = render(tree());
  return {
    requests,
    setUser(user: typeof authState.user) {
      authState.user = user;
      authState.status = user ? "authenticated" : "guest";
      rendered.rerender(tree());
    },
  };
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  authState.user = null;
  authState.status = "guest";
  vi.unstubAllGlobals();
});

describe("site-wide chatbot", () => {
  it("answers greeting-only messages immediately without a backend request", async () => {
    const { requests } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "hii!" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/Tell me what you’re interested in learning/)).toBeInTheDocument();
    expect(requests.some((entry) => entry.path === "/ai/chatbot")).toBe(false);
  });

  it("supports plain-English responses and exposes the conversation as an accessible log", async () => {
    const { requests } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    expect(screen.getByText("Response language: English")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
    fireEvent.click(
      screen.getByLabelText("Use plain English with shorter sentences and simpler words"),
    );
    const question = screen.getByLabelText("Your question");
    fireEvent.change(question, { target: { value: "How do I build a study habit?" } });
    fireEvent.keyDown(question, { key: "Enter", shiftKey: false });
    expect(await screen.findByText("Start with small, reusable components.")).toBeInTheDocument();
    expect(requests.find((entry) => entry.path === "/ai/chatbot")?.body).toEqual({
      message: "How do I build a study habit?",
      plainLanguage: true,
    });
  });

  it("lets a guest ask general questions without sending course or student context", async () => {
    const { requests } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    expect(
      screen.getByText(/What are you interested in learning, or what career goal are you working toward/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "How do I build a study habit?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Start with small, reusable components.")).toBeInTheDocument();
    const request = requests.find((entry) => entry.path === "/ai/chatbot");
    expect(request?.body).toEqual({ message: "How do I build a study habit?" });
    expect(request?.init.credentials).toBe("include");

    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "Can you explain that?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(requests.filter((entry) => entry.path === "/ai/chatbot")).toHaveLength(2),
    );
    expect(
      requests.find(
        (entry) => entry.path === "/ai/chatbot" && entry.body?.message === "Can you explain that?",
      )?.body,
    ).toEqual({
      message: "Can you explain that?",
      history: [
        { role: "user", message: "How do I build a study habit?" },
        { role: "assistant", message: "Start with small, reusable components." },
      ],
    });
  });

  it("offers a student's active courses and routes selected questions through the PDF tutor", async () => {
    authState.user = { id: "student-1", role: "STUDENT" };
    authState.status = "authenticated";
    const { requests } = mount((request) =>
      request.path === "/ai/chatbot"
        ? {
            success: true,
            chatbot: {
              message: "A component is a reusable UI unit.",
              citations: [
                {
                  materialId: "999999999999999999999999",
                  title: "React notes",
                  pageStart: 2,
                  pageEnd: 2,
                },
              ],
            },
          }
        : undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    const coursePicker = await screen.findByLabelText("Ask about an enrolled course");
    await waitFor(() => expect(coursePicker).toHaveTextContent("Learning React"));
    fireEvent.change(coursePicker, { target: { value: activeCourse.course.id } });
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "Explain the component pattern." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("A component is a reusable UI unit.")).toBeInTheDocument();
    expect(screen.getByText("React notes · pages 2")).toBeInTheDocument();
    expect(requests.find((entry) => entry.path === "/ai/chatbot")?.body).toEqual({
      message: "Explain the component pattern.",
      courseId: activeCourse.course.id,
    });
  });

  it("uses the current course and lesson handoff only after the active course is authorized", async () => {
    authState.user = { id: "student-1", role: "STUDENT" };
    authState.status = "authenticated";
    const { requests } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    await screen.findByLabelText("Ask about an enrolled course");
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "General question before changing context" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Start with small, reusable components.");

    act(() => requestCourseTutorHandoff(activeCourse.course.id, activeCourse.nextLecture.id));
    await waitFor(() =>
      expect(screen.getByLabelText("Ask about an enrolled course")).toHaveValue(
        activeCourse.course.id,
      ),
    );
    expect(screen.queryByText("General question before changing context")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "Explain this lesson." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(
        requests.find(
          (entry) => entry.path === "/ai/chatbot" && entry.body?.message === "Explain this lesson.",
        )?.body,
      ).toEqual({
        message: "Explain this lesson.",
        courseId: activeCourse.course.id,
        lectureId: activeCourse.nextLecture.id,
      }),
    );
  });

  it("keeps general chat available when a handed-off course is not actively enrolled", async () => {
    authState.user = { id: "student-1", role: "STUDENT" };
    authState.status = "authenticated";
    const { requests } = mount((request) =>
      request.path === "/ai/guidance"
        ? {
            success: true,
            guidance: {
              activeCourses: [],
              recap: { courseCount: 0, completedLessons: 0, totalLessons: 0, upcomingWork: [] },
            },
          }
        : undefined,
    );
    act(() => requestCourseTutorHandoff(activeCourse.course.id, activeCourse.nextLecture.id));

    expect(
      await screen.findByText(
        "This course is not in your active enrollments. General chat is still available.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Ask about an enrolled course")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "What is a component?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(requests.find((entry) => entry.path === "/ai/chatbot")?.body).toEqual({
        message: "What is a component?",
      }),
    );
  });

  it("clears chat history when the authenticated account changes", async () => {
    authState.user = { id: "student-1", role: "STUDENT" };
    authState.status = "authenticated";
    const { requests, setUser } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    await screen.findByLabelText("Ask about an enrolled course");
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "Private account question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Start with small, reusable components.");

    act(() => setUser({ id: "student-2", role: "STUDENT" }));
    await waitFor(() =>
      expect(screen.queryByText("Private account question")).not.toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "A new account question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(
        requests.find(
          (entry) =>
            entry.path === "/ai/chatbot" && entry.body?.message === "A new account question",
        )?.body,
      ).toEqual({ message: "A new account question" }),
    );
  });

  it("ignores malformed handoff details rather than setting a course scope", async () => {
    authState.user = { id: "student-1", role: "STUDENT" };
    authState.status = "authenticated";
    const { requests } = mount();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(COURSE_TUTOR_HANDOFF_EVENT, {
          detail: {
            courseId: activeCourse.course.id,
            lectureId: activeCourse.nextLecture.id,
            studentId: "attacker-controlled",
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask SkillForge" }));
    await screen.findByLabelText("Ask about an enrolled course");
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "General only." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(requests.find((entry) => entry.path === "/ai/chatbot")?.body).toEqual({
        message: "General only.",
      }),
    );
  });
});
