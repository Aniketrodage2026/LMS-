const AIStudyPlan = require('../../models/ai-study-plan.schema');
const AppError = require('../../utils/appError');
const { buildStudentContext } = require('./student-context.service');
const { objectId, safeText } = require('./learning-profile.service');

const MAX_SESSIONS = 21;
const DEFAULT_MINUTES = { LESSON: 30, QUIZ: 30, ASSIGNMENT: 45 };
const KIND_ORDER = { ASSIGNMENT: 0, LESSON: 1, QUIZ: 2 };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function invalidPlan() {
  return new AppError('Provide a valid seven-day date range and time zone.', 400, 'AI_STUDY_PLAN_INVALID');
}

function unavailablePlan() {
  return new AppError('The study plan is temporarily unavailable. Please try again later.', 503, 'AI_STUDY_PLAN_UNAVAILABLE');
}

function parseDateKey(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw invalidPlan();
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) throw invalidPlan();
  return date;
}

function addDays(dateKey, count) {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function dateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function zonedTimeToDate(dateKey, timeZone, hour = 9) {
  const calendarDate = parseDateKey(dateKey);
  const target = Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate(), hour);
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const actual = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    const difference = target - actual;
    timestamp += difference;
    if (difference === 0) break;
  }
  return new Date(timestamp);
}

function validateRequest({ startDate, timeZone }, now) {
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw invalidPlan();
  let localToday;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
    localToday = dateKeyInZone(now, timeZone);
  } catch {
    throw invalidPlan();
  }
  parseDateKey(startDate);
  const lastAllowedStart = addDays(localToday, 7);
  if (startDate < localToday || startDate > lastAllowedStart) throw invalidPlan();
  return { startDate, endDate: addDays(startDate, 6), timeZone, weekStart: parseDateKey(startDate) };
}

function taskId(task) {
  return `${task.kind}:${task.courseId}:${task.sourceId}`;
}

function candidatesFromContext(context, period) {
  const candidates = [];
  for (const active of context.activeCourses) {
    if (active.nextLecture) {
      candidates.push({
        kind: 'LESSON', courseId: active.course.id, courseTitle: active.course.title,
        sourceId: active.nextLecture.id, title: `Study lesson: ${active.nextLecture.title}`,
        minutes: DEFAULT_MINUTES.LESSON, dueAt: null, dueDay: null
      });
    }
    const nextQuiz = active.assessments.quizzes.find((quiz) => !quiz.passed);
    if (nextQuiz) {
      candidates.push({
        kind: 'QUIZ', courseId: active.course.id, courseTitle: active.course.title,
        sourceId: nextQuiz.id, title: `Review quiz: ${nextQuiz.title}`,
        minutes: DEFAULT_MINUTES.QUIZ, dueAt: null, dueDay: null
      });
    }
    for (const assignment of active.assessments.assignments) {
      if (assignment.status !== 'NOT_SUBMITTED' || !assignment.dueDate) continue;
      const dueAt = new Date(assignment.dueDate);
      if (!Number.isFinite(dueAt.getTime())) continue;
      const dueDay = dateKeyInZone(dueAt, period.timeZone);
      if (dueDay < period.startDate || dueDay > period.endDate) continue;
      candidates.push({
        kind: 'ASSIGNMENT', courseId: active.course.id, courseTitle: active.course.title,
        sourceId: assignment.id, title: `Work on assignment: ${assignment.title}`,
        minutes: DEFAULT_MINUTES.ASSIGNMENT, dueAt, dueDay
      });
    }
  }
  return candidates.sort((left, right) => (
    (left.dueDay || period.endDate).localeCompare(right.dueDay || period.endDate)
      || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || left.courseTitle.localeCompare(right.courseTitle)
      || left.title.localeCompare(right.title)
  ));
}

function scheduleCandidates(candidates, profile, period) {
  if (!Number.isInteger(profile?.weeklyAvailabilityHours)) {
    return {
      availableMinutes: null, plannedMinutes: 0, sessions: [],
      message: 'Add your weekly study availability to your learning profile to build a plan.'
    };
  }
  const availableMinutes = profile.weeklyAvailabilityHours * 60;
  const dayLoads = Array(7).fill(0);
  const sessions = [];
  let plannedMinutes = 0;
  for (const candidate of candidates) {
    if (sessions.length >= MAX_SESSIONS) break;
    if (plannedMinutes + candidate.minutes > availableMinutes) continue;
    const latestDay = candidate.dueDay
      ? Math.max(0, Math.min(6, Math.floor((parseDateKey(candidate.dueDay) - parseDateKey(period.startDate)) / 86400000)))
      : 6;
    let selectedDay = 0;
    for (let day = 1; day <= latestDay; day += 1) {
      if (dayLoads[day] < dayLoads[selectedDay]) selectedDay = day;
    }
    const day = addDays(period.startDate, selectedDay);
    dayLoads[selectedDay] += candidate.minutes;
    plannedMinutes += candidate.minutes;
    sessions.push({ ...candidate, day, id: taskId(candidate) });
  }
  return {
    availableMinutes,
    plannedMinutes,
    sessions,
    message: sessions.length ? null : candidates.length
      ? 'Your weekly availability is too limited for the suggested session lengths. Increase availability in your profile to create a plan.'
      : 'No incomplete lessons or upcoming published assessments were found for your active courses.'
  };
}

function serializePlan(plan) {
  return {
    weekStart: dateKeyInZone(plan.weekStart, 'UTC'),
    timeZone: plan.timeZone,
    availableMinutes: plan.totalAvailableMinutes,
    plannedMinutes: plan.sessions.reduce((sum, session) => sum + session.minutes, 0),
    sessions: plan.sessions.slice().sort((left, right) => left.position - right.position).map((session) => ({
      id: `${session.kind}:${session.course}:${session.source}`,
      kind: session.kind,
      courseId: String(session.course),
      courseTitle: safeText(session.courseTitle, 80),
      sourceId: String(session.source),
      title: safeText(session.title, 160),
      day: dateKeyInZone(session.scheduledAt, plan.timeZone),
      dueDay: session.dueAt ? dateKeyInZone(session.dueAt, plan.timeZone) : null,
      minutes: session.minutes
    }))
  };
}

function serializeDraft(period, plan) {
  return {
    weekStart: period.startDate,
    timeZone: period.timeZone,
    availableMinutes: plan.availableMinutes,
    plannedMinutes: plan.plannedMinutes,
    message: plan.message,
    sessions: plan.sessions.map((session) => ({
      id: session.id,
      kind: session.kind,
      courseId: session.courseId,
      courseTitle: safeText(session.courseTitle, 80),
      sourceId: session.sourceId,
      title: safeText(session.title, 160),
      day: session.day,
      dueDay: session.dueDay,
      minutes: session.minutes
    }))
  };
}

function createStudyPlanService({ now = () => new Date() } = {}) {
  async function getContext(student) {
    return buildStudentContext(student);
  }

  async function build(studentId, request) {
    const student = objectId(studentId, 'studentId');
    const period = validateRequest(request, now());
    const context = await getContext(student);
    const candidates = candidatesFromContext(context, period);
    return {
      period,
      context,
      candidates,
      plan: scheduleCandidates(candidates, context.profile, period)
    };
  }

  return {
    async preview(studentId, request) {
      const result = await build(studentId, request);
      return serializeDraft(result.period, result.plan);
    },

    async get(studentId, request) {
      const result = await build(studentId, request);
      const saved = await AIStudyPlan.findOne({
        student: objectId(studentId, 'studentId'),
        weekStart: result.period.weekStart
      }).lean();
      if (!saved) return { plan: null, preview: serializeDraft(result.period, { ...result.plan, sessions: [], plannedMinutes: 0 }) };

      const valid = new Map(result.candidates.map((candidate) => [taskId(candidate), candidate]));
      const activeCourseIds = new Set(result.context.activeCourses.map(({ course }) => course.id));
      const sessions = saved.sessions.filter((session) => activeCourseIds.has(String(session.course))
        && valid.has(`${session.kind}:${session.course}:${session.source}`))
        .map((session) => {
          const current = valid.get(`${session.kind}:${session.course}:${session.source}`);
          return {
            ...session,
            courseTitle: current.courseTitle,
            title: current.title,
            dueAt: current.dueAt
          };
        });
      return { plan: serializePlan({ ...saved, sessions }), preview: null };
    },

    async save(studentId, request) {
      const result = await build(studentId, request);
      const student = objectId(studentId, 'studentId');
      const { sessions } = request;
      if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS
        || !Number.isInteger(result.plan.availableMinutes)) throw invalidPlan();
      const allowed = new Map(result.candidates.map((candidate) => [taskId(candidate), candidate]));
      const used = new Set();
      let totalMinutes = 0;
      const normalized = sessions.map((session, position) => {
        if (!session || typeof session !== 'object' || Array.isArray(session)
          || Object.keys(session).some((key) => !['id', 'day', 'minutes'].includes(key))
          || typeof session.id !== 'string' || !DATE_PATTERN.test(session.day)
          || !Number.isInteger(session.minutes) || session.minutes < 15 || session.minutes > 180) throw invalidPlan();
        const candidate = allowed.get(session.id);
        if (!candidate || used.has(session.id) || session.day < result.period.startDate || session.day > result.period.endDate
          || (candidate.dueDay && session.day > candidate.dueDay)) throw invalidPlan();
        used.add(session.id);
        totalMinutes += session.minutes;
        return {
          kind: candidate.kind,
          course: candidate.courseId,
          source: candidate.sourceId,
          courseTitle: candidate.courseTitle,
          title: candidate.title,
          scheduledAt: zonedTimeToDate(session.day, result.period.timeZone),
          dueAt: candidate.dueAt,
          minutes: session.minutes,
          position
        };
      });
      if (totalMinutes > result.plan.availableMinutes) throw invalidPlan();

      let document = await AIStudyPlan.findOne({ student, weekStart: result.period.weekStart });
      if (!document) document = new AIStudyPlan({
        student,
        weekStart: result.period.weekStart,
        timeZone: result.period.timeZone,
        totalAvailableMinutes: result.plan.availableMinutes,
        sessions: normalized
      });
      else {
        document.timeZone = result.period.timeZone;
        document.totalAvailableMinutes = result.plan.availableMinutes;
        document.sessions = normalized;
      }
      try {
        await document.save();
      } catch (error) {
        if (error?.code !== 11000) throw error;
        document = await AIStudyPlan.findOne({ student, weekStart: result.period.weekStart });
        if (!document) throw error;
        document.timeZone = result.period.timeZone;
        document.totalAvailableMinutes = result.plan.availableMinutes;
        document.sessions = normalized;
        await document.save();
      }
      return serializePlan(document);
    },

    async remove(studentId, request) {
      const period = validateRequest(request, now());
      const result = await AIStudyPlan.deleteOne({
        student: objectId(studentId, 'studentId'),
        weekStart: period.weekStart
      });
      return { deleted: result.deletedCount === 1 };
    }
  };
}

module.exports = {
  createStudyPlanService,
  dateKeyInZone,
  zonedTimeToDate,
  validateRequest,
  scheduleCandidates
};
