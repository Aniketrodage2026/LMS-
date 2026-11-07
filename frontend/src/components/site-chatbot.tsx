import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, MessageCircle, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAiGuidance, useSiteChatbot } from "@/lib/api/hooks";
import { useAuth } from "@/lib/api/auth";
import { errorText } from "@/lib/api/client";
import { isMaterialId } from "@/lib/api/models";
import type { ChatbotCitation } from "@/lib/api/models";
import {
  COURSE_TUTOR_HANDOFF_EVENT,
  readCourseTutorHandoff,
  type CourseTutorHandoff,
} from "@/lib/course-tutor-handoff";

type Message = {
  id: number;
  role: "user" | "assistant";
  text: string;
  citations?: ChatbotCitation[];
};

function greetingResponse(message: string) {
  return /^(?:hi+|hello+|hey+|good morning|good afternoon|good evening|greetings)[.!?,\s]*$/i
    .test(message.normalize("NFKC").trim())
    ? "Hi! I’m Ask SkillForge. Tell me what you’re interested in learning or your career goal, and I’ll help you explore published courses."
    : undefined;
}

export function SiteChatbot() {
  const { user, status } = useAuth();
  const isStudent = user?.role === "STUDENT";
  const identity = user ? `${user.id}:${user.role}` : "guest";
  const identityRef = useRef(identity);
  const conversationRef = useRef(0);
  identityRef.current = identity;
  const [open, setOpen] = useState(false);
  const guidance = useAiGuidance(open && isStudent);
  const chatbot = useSiteChatbot();
  const resetChatbot = chatbot.reset;
  const [courseId, setCourseId] = useState("");
  const [lectureId, setLectureId] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const [pendingHandoff, setPendingHandoff] = useState<CourseTutorHandoff | null>(null);
  const [draft, setDraft] = useState("");
  const [plainLanguage, setPlainLanguage] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextId, setNextId] = useState(0);
  const endOfMessages = useRef<HTMLDivElement>(null);

  useEffect(() => {
    conversationRef.current += 1;
    setMessages([]);
    setCourseId("");
    setLectureId("");
    setContextNotice("");
    setPendingHandoff(null);
    setDraft("");
    setPlainLanguage(false);
    setNextId(0);
    resetChatbot();
  }, [identity, resetChatbot]);

  useEffect(() => {
    const handleHandoff = (event: Event) => {
      const handoff = readCourseTutorHandoff(event);
      if (!handoff) return;
      setPendingHandoff(handoff);
      setOpen(true);
    };
    window.addEventListener(COURSE_TUTOR_HANDOFF_EVENT, handleHandoff);
    return () => window.removeEventListener(COURSE_TUTOR_HANDOFF_EVENT, handleHandoff);
  }, []);

  const activeCourses = useMemo(
    () => guidance.data?.activeCourses ?? [],
    [guidance.data?.activeCourses],
  );

  useEffect(() => {
    if (!pendingHandoff) return;
    if (isStudent && guidance.isLoading) return;

    conversationRef.current += 1;
    setMessages([]);
    setNextId(0);
    setDraft("");
    resetChatbot();
    if (!isStudent) {
      setCourseId("");
      setLectureId("");
      setContextNotice(
        "Course-material tutoring requires an active student enrollment. General chat is still available.",
      );
    } else if (guidance.isError) {
      setCourseId("");
      setLectureId("");
      setContextNotice(
        "Your active courses could not be verified. General chat is still available.",
      );
    } else if (activeCourses.some(({ course }) => course.id === pendingHandoff.courseId)) {
      setCourseId(pendingHandoff.courseId);
      setLectureId(pendingHandoff.lectureId ?? "");
      setContextNotice("");
    } else {
      setCourseId("");
      setLectureId("");
      setContextNotice(
        "This course is not in your active enrollments. General chat is still available.",
      );
    }
    setPendingHandoff(null);
  }, [
    pendingHandoff,
    isStudent,
    guidance.isLoading,
    guidance.isError,
    activeCourses,
    resetChatbot,
  ]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, chatbot.isPending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || text.length > 2000 || chatbot.isPending) return;
    const currentIdentity = identity;
    const currentConversation = conversationRef.current;
    const selectedCourseId =
      isStudent && activeCourses.some(({ course }) => course.id === courseId) ? courseId : "";
    const selectedLectureId = selectedCourseId && isMaterialId(lectureId) ? lectureId : undefined;
    const userMessage: Message = { id: nextId, role: "user", text };
    setDraft("");
    const instantGreeting = selectedCourseId ? undefined : greetingResponse(text);
    if (instantGreeting) {
      setMessages((items) => [
        ...items,
        userMessage,
        { id: nextId + 1, role: "assistant", text: instantGreeting },
      ]);
      setNextId((value) => value + 2);
      return;
    }
    setNextId((value) => value + 1);
    setMessages((items) => [...items, userMessage]);
    try {
      const reply = await chatbot.mutateAsync({
        message: text,
        ...(selectedCourseId ? { courseId: selectedCourseId } : {}),
        ...(selectedLectureId ? { lectureId: selectedLectureId } : {}),
        ...(plainLanguage ? { plainLanguage: true } : {}),
        ...(!selectedCourseId && messages.length
          ? { history: messages.slice(-8).map(({ role, text: message }) => ({ role, message })) }
          : {}),
      });
      if (
        identityRef.current !== currentIdentity ||
        conversationRef.current !== currentConversation
      )
        return;
      setMessages((items) => [
        ...items,
        {
          id: nextId + 1,
          role: "assistant",
          text: reply.message,
          citations: reply.citations,
        },
      ]);
      setNextId((value) => value + 1);
    } catch (error) {
      if (
        identityRef.current !== currentIdentity ||
        conversationRef.current !== currentConversation
      )
        return;
      setMessages((items) => [
        ...items,
        {
          id: nextId + 1,
          role: "assistant",
          text: errorText(error),
        },
      ]);
      setNextId((value) => value + 1);
    }
  }

  function changeCourse(nextCourseId: string) {
    if (courseId !== nextCourseId || lectureId) {
      conversationRef.current += 1;
      setMessages([]);
      setNextId(0);
      setDraft("");
      resetChatbot();
    }
    setCourseId(nextCourseId);
    setLectureId("");
    setContextNotice("");
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          className="fixed bottom-5 right-5 z-40 h-12 rounded-full px-5 shadow-lg"
          aria-label="Ask SkillForge"
        >
          <MessageCircle aria-hidden="true" />
          <span>Ask SkillForge</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        aria-describedby="site-chatbot-description"
      >
        <SheetHeader className="border-b px-5 py-5 pr-14 text-left">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" aria-hidden="true" />
            Ask SkillForge
          </SheetTitle>
          <SheetDescription id="site-chatbot-description">
            Learning help and answers about published courses.
          </SheetDescription>
        </SheetHeader>

        <div className="border-b px-5 py-4">
          {isStudent ? (
            <>
              <label
                htmlFor="chatbot-course"
                className="mb-2 flex items-center gap-2 text-sm font-medium"
              >
                <BookOpen className="size-4 text-primary" aria-hidden="true" />
                Ask about an enrolled course
              </label>
              <select
                id="chatbot-course"
                value={courseId}
                onChange={(event) => changeCourse(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">General learning and progress help</option>
                {activeCourses.map(({ course }) => (
                  <option value={course.id} key={course.id}>
                    {course.title} · PDF tutor
                  </option>
                ))}
              </select>
              {guidance.isLoading && (
                <p className="mt-2 text-xs text-muted-foreground">Loading your active courses…</p>
              )}
              {guidance.isError && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Your active courses could not be loaded. General chat is still available.
                </p>
              )}
              {!guidance.isLoading && !guidance.isError && activeCourses.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Enroll in a course to ask questions about its published PDF materials.
                </p>
              )}
              {lectureId && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Questions are scoped to the lesson you came from and published course materials.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status === "loading"
                ? "You can ask general learning questions while your account loads."
                : "Ask general learning questions or about courses in the public catalog."}
            </p>
          )}
          {contextNotice && (
            <p className="mt-2 text-xs text-muted-foreground" role="status">
              {contextNotice}
            </p>
          )}
          <div className="mt-4 grid gap-2">
            <p className="mb-0 text-xs text-muted-foreground">Response language: English</p>
            <label htmlFor="chatbot-plain-language" className="flex items-start gap-2 text-sm">
              <input
                id="chatbot-plain-language"
                type="checkbox"
                className="mt-1 accent-primary"
                checked={plainLanguage}
                onChange={(event) => setPlainLanguage(event.target.checked)}
              />
              <span>Use plain English with shorter sentences and simpler words</span>
            </label>
          </div>
        </div>

        <div
          className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
        >
          {messages.length === 0 && (
            <article
              className="mr-auto max-w-[90%] rounded-xl border bg-card px-4 py-3 text-sm text-card-foreground"
              aria-label="Assistant response"
            >
              <p className="mb-0">
                What are you interested in learning, or what career goal are you working toward?
                Share your experience level too, and I’ll suggest a matching published course.
                {isStudent
                  ? " You can also ask about your progress or select an active course for PDF tutoring."
                  : " You can also ask any general learning question."}
              </p>
            </article>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={`max-w-[90%] rounded-xl px-4 py-3 text-sm ${
                message.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "mr-auto border bg-card text-card-foreground"
              }`}
              aria-label={message.role === "user" ? "Your message" : "Assistant response"}
            >
              <p className="mb-0 whitespace-pre-wrap break-words">{message.text}</p>
              {!!message.citations?.length && (
                <ul className="mt-3 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                  {message.citations.map((citation) => (
                    <li key={`${citation.materialId}:${citation.pageStart}`}>
                      {citation.title} · pages{" "}
                      {citation.pageStart === citation.pageEnd
                        ? citation.pageStart
                        : `${citation.pageStart}–${citation.pageEnd}`}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          {chatbot.isPending && (
            <p
              className="mr-auto rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground"
              role="status"
            >
              Thinking…
            </p>
          )}
          <div ref={endOfMessages} />
        </div>

        <form onSubmit={submit} className="border-t bg-background p-4">
          <label htmlFor="chatbot-message" className="sr-only">
            Your question
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id="chatbot-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              maxLength={2000}
              rows={2}
              placeholder="Ask a question…"
              className="max-h-32 min-h-11 flex-1 resize-y rounded-md border bg-card px-3 py-2 text-sm"
              aria-describedby="chatbot-history-note"
              disabled={chatbot.isPending}
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send message"
              disabled={!draft.trim() || chatbot.isPending}
            >
              <Send aria-hidden="true" />
            </Button>
          </div>
          <p id="chatbot-history-note" className="mb-0 mt-2 text-xs text-muted-foreground">
            {isStudent
              ? "Chat history stays in this page only."
              : "Answers use public course information only."}
          </p>
        </form>
      </SheetContent>
    </Sheet>
  );
}
