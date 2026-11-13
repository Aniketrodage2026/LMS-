import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, MessageCircle, Send, Sparkles, TrendingUp, Search, Users, Calendar, ChevronRight } from "lucide-react";

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

const QUICK_ACTIONS = [
  { icon: TrendingUp, label: "Career pathways", color: "text-blue-600", bg: "bg-blue-50" },
  { icon: Search, label: "Find courses", color: "text-green-600", bg: "bg-green-50" },
  { icon: Users, label: "Learn about instructors", color: "text-purple-600", bg: "bg-purple-50" },
  { icon: Calendar, label: "Study plans", color: "text-orange-600", bg: "bg-orange-50" }
];

const POPULAR_COURSES = [
  { id: "1", title: "Full Stack Web Development", level: "Beginner", duration: "3 months", price: "Free", enrollment: "2.5k+ students" },
  { id: "2", title: "Data Science & ML", level: "Intermediate", duration: "4 months", price: "$500", enrollment: "1.8k+ students" },
  { id: "3", title: "Digital Marketing Mastery", level: "Beginner", duration: "2.5 months", price: "$300", enrollment: "3.2k+ students" }
];

export function SiteChatbot() {
  const { user, status } = useAuth();
  const isStudent = user?.role === "STUDENT";
  const identity = user ? `${user.id}:${user.role}` : "guest";
  const identityRef = useRef(identity);
  const conversationRef = useRef(0);
  identityRef.current = identity;
  const [open, setOpen] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [selectedCareerPath, setSelectedCareerPath] = useState("");
  const [progressTooltip, setProgressTooltip] = useState<{id: string, title: string} | null>(null);
  const guidance = useAiGuidance(open && isStudent);
  const chatbot = useSiteChatbot();
  const resetChatbot = chatbot.reset;
  const [courseId, setCourseId] = useState("");
  const [lectureId, setLectureId] = useState("");
  const [showLanguageToggle, setShowLanguageToggle] = useState(false);
  const [contextNotice, setContextNotice] = useState("");
  const [pendingHandoff, setPendingHandoff] = useState<CourseTutorHandoff | null>(null);
  const [draft, setDraft] = useState("");
  const [plainLanguage, setPlainLanguage] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextId, setNextId] = useState(0);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    setShowSuggestions(true);
    setSelectedCareerPath("");
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
    if (!open) {
      setShowSuggestions(true);
      setSelectedCareerPath("");
    }
  }, [open]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, chatbot.isPending]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (messages.length === 0 && open) {
      setShowSuggestions(true);
    }
  }, [messages.length, open]);

  const handleQuickAction = (action: string) => {
    if (action === "Career pathways") {
      setMessages((items) => [...items, {
        id: nextId + 1,
        role: "assistant",
        text: "I can help you explore career pathways! What interests you most? Here are some popular options:\n\n• Technology: Web Development, Data Science, Mobile Apps\n• Business: Marketing, Project Management, Entrepreneurship\n• Creative: Design, Content Creation, Animation\n\nWhat career field are you most excited about exploring?"
      }]);
      setNextId((value) => value + 1);
    } else if (action === "Find courses") {
      setMessages((items) => [...items, {
        id: nextId + 1,
        role: "assistant",
        text: "Great! I can help you find the perfect courses. What would you like to learn?\n\n• Programming: Python, JavaScript, Java\n• Data: Analytics, Machine Learning, Statistics\n• Business: Marketing, Finance, Management\n\nTell me your learning goal, and I'll find matching courses for you!"
      }]);
      setNextId((value) => value + 1);
    }
  };

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
          className="fixed bottom-5 right-5 z-40 h-14 rounded-full px-6 shadow-2xl bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary text-primary-foreground border-2 border-primary/20 transition-all duration-300 hover:scale-105 hover:shadow-xl group"
          aria-label="Ask SkillForge"
        >
          <div className="w-8 h-8 rounded-full bg-primary-foreground/20 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
            <MessageCircle aria-hidden="true" className="w-5 h-5" />
          </div>
          <span className="font-semibold tracking-wide">Ask SkillForge</span>
          <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background animate-pulse" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md bg-gradient-to-b from-background to-muted/10 backdrop-blur-sm"
        aria-describedby="site-chatbot-description"
      >
        <SheetHeader className="border-b border-border/50 bg-gradient-to-r from-background to-muted/20 px-5 py-5 pr-14 text-left">
          <SheetTitle className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg shadow-primary/25">
              <Sparkles className="size-5 text-primary-foreground" aria-hidden="true" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold leading-tight">Ask SkillForge</h2>
              <p className="text-xs text-muted-foreground font-normal">Your AI learning assistant</p>
            </div>
          </SheetTitle>
          <SheetDescription id="site-chatbot-description" className="mt-2">
            Learning help and answers about published courses.
          </SheetDescription>
        </SheetHeader>

        <div className="border-b border-border/50 bg-muted/20 px-5 py-4">
          {isStudent ? (
            <>
              <label
                htmlFor="chatbot-course"
                className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <BookOpen className="size-4 text-primary" aria-hidden="true" />
                </div>
                Ask about an enrolled course
              </label>
              <select
                id="chatbot-course"
                value={courseId}
                onChange={(event) => changeCourse(event.target.value)}
                className="h-11 w-full rounded-xl border border-border/50 bg-card px-4 text-sm shadow-sm hover:shadow-md transition-all duration-200 focus:border-primary/50 focus:shadow-lg focus:outline-none"
              >
                <option value="">General learning and progress help</option>
                {activeCourses.map(({ course }) => (
                  <option value={course.id} key={course.id}>
                    {course.title} · PDF tutor
                  </option>
                ))}
              </select>
              {guidance.isLoading && (
                <p className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                  <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Loading your active courses…
                </p>
              )}
              {guidance.isError && (
                <p className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  Your active courses could not be loaded. General chat is still available.
                </p>
              )}
              {!guidance.isLoading && !guidance.isError && activeCourses.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  Enroll in a course to ask questions about its published PDF materials.
                </p>
              )}
              {lectureId && (
                <p className="mt-2 text-xs text-muted-foreground flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  Questions are scoped to the lesson you came from and published course materials.
                </p>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/50">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                <Sparkles className="size-4 text-blue-600" />
              </div>
              <p className="text-sm text-muted-foreground">
                {status === "loading"
                  ? "You can ask general learning questions while your account loads."
                  : "Ask general learning questions or about courses in the public catalog."}
              </p>
            </div>
          )}
          {contextNotice && (
            <p className="mt-3 text-xs text-amber-600 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              {contextNotice}
            </p>
          )}
          <div className="mt-4 grid gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Response language</p>
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                English
              </span>
            </div>
            <label htmlFor="chatbot-plain-language" className="flex items-start gap-3 p-3 rounded-xl border border-border/50 bg-card hover:bg-muted/50 transition-all duration-200 cursor-pointer">
              <input
                id="chatbot-plain-language"
                type="checkbox"
                className="mt-1 accent-primary"
                checked={plainLanguage}
                onChange={(event) => setPlainLanguage(event.target.checked)}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">Use plain English</span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Shorter sentences and simpler words
                </p>
              </div>
            </label>
          </div>
        </div>

        <div
          className="flex-1 space-y-4 overflow-y-auto px-5 py-5 bg-gradient-to-b from-background to-muted/20 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
        >
          {messages.length === 0 && showSuggestions && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <article
                className="mr-auto max-w-[90%] rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm px-5 py-4 text-sm shadow-sm hover:shadow-md transition-all duration-200"
                aria-label="Assistant response"
              >
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="mb-0 font-medium text-foreground">Welcome to Ask SkillForge</p>
                    <p className="mb-0 text-muted-foreground mt-1">
                      What are you interested in learning, or what career goal are you working toward?
                      Share your experience level too, and I’ll suggest a matching published course.
                      {isStudent
                        ? " You can also ask about your progress or select an active course for PDF tutoring."
                        : " You can also ask any general learning question."}
                    </p>
                  </div>
                </div>
              </article>

              <div className="mt-6">
                <div className="flex items-center justify-between mb-3 px-1">
                  <p className="text-sm font-medium text-muted-foreground">Quick Start Options</p>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                    {QUICK_ACTIONS.length} options
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {QUICK_ACTIONS.map((action, index) => {
                    const Icon = action.icon;
                    return (
                      <button
                        key={index}
                        onClick={() => handleQuickAction(action.label)}
                        className="group flex flex-col items-center text-center p-4 rounded-xl border border-border/50 bg-card hover:bg-muted/50 hover:border-primary/30 transition-all duration-200 cursor-pointer"
                      >
                        <div className={`w-12 h-12 rounded-xl ${action.bg} ${action.color} flex items-center justify-center group-hover:scale-105 group-hover:rotate-3 transition-transform duration-300 mb-2`}>
                          <Icon className="w-6 h-6" />
                        </div>
                        <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors duration-200">
                          {action.label}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {action.label === "Career pathways" && "Explore different career directions"}
                          {action.label === "Find courses" && "Discover relevant learning opportunities"}
                          {action.label === "Learn about instructors" && "Meet expert instructors"}
                          {action.label === "Study plans" && "Create structured learning paths"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between mb-3 px-1">
                  <p className="text-sm font-medium text-muted-foreground">Popular Courses</p>
                  <button
                    type="button"
                    onClick={() => setMessages((items) => [...items, {
                      id: nextId + 1,
                      role: "assistant",
                      text: "I can help you explore all available courses! What would you like to learn? I can search by topic, filter by price, or show you the most popular courses in each category."
                    }])}
                    className="text-xs text-primary hover:text-primary/80 font-medium transition-colors duration-200"
                  >
                    View all →
                  </button>
                </div>
                <div className="space-y-3">
                  {POPULAR_COURSES.map((course, index) => (
                    <button
                      key={course.id}
                      type="button"
                      onClick={() => setMessages((items) => [...items, {
                        id: nextId + 1,
                        role: "assistant",
                        text: `Tell me more about "${course.title}"! This is a ${course.level.toLowerCase()} level course that takes ${course.duration} to complete. It's ${course.price === "Free" ? "completely free" : `priced at ${course.price}`}, and has been taken by ${course.enrollment}. What would you like to know about it?`
                      }])}
                      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-card hover:bg-muted/50 hover:border-primary/30 transition-all duration-200 cursor-pointer group text-left"
                    >
                      <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
                        <BookOpen className="w-6 h-6 text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors duration-200">
                          {course.title}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                          <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                            {course.level}
                          </span>
                          <span>•</span>
                          <span>{course.duration}</span>
                          <span>•</span>
                          <span className={`px-1.5 py-0.5 rounded font-medium ${
                            course.price === "Free"
                              ? "bg-green-50 text-green-700"
                              : "bg-amber-50 text-amber-700"
                          }`}>
                            {course.price}
                          </span>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground text-right">
                        <p className="font-medium text-foreground">{course.enrollment}</p>
                        <p>students</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all duration-200" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={`max-w-[90%] rounded-2xl px-5 py-4 text-sm shadow-sm hover:shadow-md transition-all duration-200 animate-in fade-in slide-in-from-bottom-2 ${
                message.role === "user"
                  ? "ml-auto bg-gradient-to-r from-primary to-primary/90 text-primary-foreground border border-primary/20"
                  : "mr-auto border border-border/50 bg-card/80 backdrop-blur-sm text-card-foreground"
              }`}
              aria-label={message.role === "user" ? "Your message" : "Assistant response"}
            >
              {message.role === "assistant" && (
                <div className="flex items-start gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center flex-shrink-0 shadow-sm">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="mb-0 whitespace-pre-wrap break-words leading-relaxed text-foreground">
                      {message.text}
                    </p>
                  </div>
                </div>
              )}
              {message.role === "assistant" && !!message.citations?.length && (
                <div className="mt-4 pt-3 border-t border-border/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-muted-foreground">Sources</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {message.citations.length}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {message.citations.map((citation) => (
                      <li key={`${citation.materialId}:${citation.pageStart}`} className="text-xs flex items-start gap-2">
                        <span className="text-primary font-medium mt-0.5">•</span>
                        <span className="text-muted-foreground">
                          {citation.title} · pages{" "}
                          {citation.pageStart === citation.pageEnd
                            ? citation.pageStart
                            : `${citation.pageStart}–${citation.pageEnd}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {message.role === "user" && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary-foreground/20 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-semibold text-primary-foreground">You</span>
                  </div>
                  <div className="flex-1">
                    <p className="mb-0 whitespace-pre-wrap break-words leading-relaxed font-medium">
                      {message.text}
                    </p>
                  </div>
                </div>
              )}
            </article>
          ))}
          {chatbot.isPending && (
            <div className="mr-auto max-w-[90%] rounded-2xl border border-border/50 bg-card/80 px-5 py-4 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-center gap-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <p className="text-sm text-muted-foreground">Thinking…</p>
              </div>
            </div>
          )}
          <div ref={endOfMessages} />
        </div>

        <form onSubmit={submit} className="border-t bg-gradient-to-t from-muted/30 to-background p-5">
          <label htmlFor="chatbot-message" className="sr-only">
            Your question
          </label>
          <div className="flex items-end gap-3 max-w-4xl mx-auto">
            <div className="relative flex-1">
              <textarea
                id="chatbot-message"
                ref={inputRef}
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
                placeholder="Ask about a course, career path, or learning goal..."
                className="max-h-32 min-h-11 w-full resize-y rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm px-4 py-3 text-sm shadow-sm hover:shadow-md transition-all duration-200 focus:border-primary/50 focus:shadow-lg focus:outline-none"
                aria-describedby="chatbot-history-note chatbot-character-count"
                disabled={chatbot.isPending}
              />
              {draft.length > 0 && (
                <div className="absolute right-3 bottom-3 text-xs text-muted-foreground">
                  {draft.length}/2000
                </div>
              )}
            </div>
            <Button
              type="submit"
              disabled={!draft.trim() || chatbot.isPending}
              className="h-11 px-6 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Send message"
            >
              {chatbot.isPending ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send
                </>
              )}
            </Button>
          </div>
          <div className="mt-3 text-center">
            <p className="text-xs text-muted-foreground">
              Press Enter to send, Shift+Enter for new line
            </p>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
