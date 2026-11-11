const AIStudyPlan = require('../../models/ai-study-plan.schema');
const { buildStudentContext } = require('./student-context.service');
const { objectId, safeText } = require('./learning-profile.service');

const MAX_ACTIONS = 3;
const ESTIMATED_MINUTES = { LESSON: 30, QUIZ: 30, ASSIGNMENT: 45 };

function dateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function action({ kind, course, sourceId, title, reason, minutes, priority, dueAt = null, scheduledToday = false }) {
  return {
    kind,
    courseId: course.id,
    sourceId,
    courseTitle: safeText(course.title, 80),
    title: safeText(title, 160),
    reason: safeText(reason, 240),
    minutes,
    priority,
    dueAt,
    scheduledToday
  };
}

function actionKey(item) {
  return `${item.courseId}:${item.sourceId}`;
}

function currentTasks(context, now) {
  const items = [];
  for (const active of context.activeCourses) {
    const { course } = active;
    if (active.nextLecture) {
      const paused = active.activityStatus === 'PAUSED';
      items.push(action({
        kind: 'CONTINUE_LESSON', course, sourceId: active.nextLecture.id,
        title: `Continue: ${active.nextLecture.title}`,
        reason: paused
          ? 'This is your next incomplete lesson. You can pick up when you are ready.'
          : 'This is the next incomplete lesson in your active course.',
        minutes: ESTIMATED_MINUTES.LESSON, priority: paused ? 65 : 55
      }));
    }

    for (const quiz of active.assessments.quizzes.filter((item) => !item.passed).slice(0, 1)) {
      items.push(action({
        kind: 'REVIEW_QUIZ', course, sourceId: quiz.id, title: `Review quiz: ${quiz.title}`,
        reason: quiz.bestPercentage === null
          ? 'This published quiz is ready when you want to check your understanding.'
          : 'A new attempt can help you review this published quiz topic.',
        minutes: ESTIMATED_MINUTES.QUIZ, priority: 45
      }));
    }

    for (const assignment of active.assessments.assignments.filter((item) => item.status === 'NOT_SUBMITTED')) {
      const dueTime = assignment.dueDate ? new Date(assignment.dueDate).getTime() : NaN;
      const hoursUntilDue = Number.isFinite(dueTime) ? (dueTime - now.getTime()) / (60 * 60 * 1000) : null;
      const dueSoon = hoursUntilDue !== null && hoursUntilDue <= 72;
      items.push(action({
        kind: 'PREPARE_ASSIGNMENT', course, sourceId: assignment.id,
        title: `Work on: ${assignment.title}`,
        reason: dueSoon
          ? hoursUntilDue < 0
            ? 'The due date has passed. Review the assignment status and submit if your instructor still accepts work.'
            : 'This published assignment is due soon. A focused work session can help you prepare.'
          : 'Set aside focused time for this published assignment before its due date.',
        minutes: ESTIMATED_MINUTES.ASSIGNMENT, priority: dueSoon ? 95 : 60,
        dueAt: Number.isFinite(dueTime) ? new Date(dueTime).toISOString() : null
      }));
    }
  }
  return items;
}

async function scheduledToday(student, context, tasks, now) {
  const plans = await AIStudyPlan.find({ student })
    .select('timeZone sessions.kind sessions.course sessions.source sessions.scheduledAt sessions.minutes')
    .sort({ weekStart: -1, updatedAt: -1 }).limit(8).lean();
  const taskByKey = new Map(tasks.map((item) => [actionKey(item), item]));
  const activeCourseIds = new Set(context.activeCourses.map(({ course }) => course.id));
  const scheduled = [];
  for (const plan of plans) {
    if (typeof plan.timeZone !== 'string' || plan.timeZone.length > 80) continue;
    let today;
    try { today = dateKeyInZone(now, plan.timeZone); } catch { continue; }
    for (const session of plan.sessions || []) {
      if (!activeCourseIds.has(String(session.course)) || !session.scheduledAt) continue;
      let sessionDay;
      try { sessionDay = dateKeyInZone(session.scheduledAt, plan.timeZone); } catch { continue; }
      if (sessionDay !== today) continue;
      const task = taskByKey.get(`${String(session.course)}:${String(session.source)}`);
      if (!task) continue;
      scheduled.push({
        ...task,
        title: `Today's plan: ${task.title.replace(/^(?:Continue: |Review quiz: |Work on: )/, '')}`,
        reason: 'This task is scheduled in your saved study plan for today.',
        minutes: Number.isInteger(session.minutes) ? session.minutes : task.minutes,
        priority: task.priority >= 95 ? 100 : 85,
        scheduledToday: true
      });
    }
  }
  return scheduled;
}

function selectActions(items) {
  const selected = [];
  const seen = new Set();
  for (const item of items.sort((left, right) => right.priority - left.priority
    || (left.dueAt || '').localeCompare(right.dueAt || '')
    || left.courseTitle.localeCompare(right.courseTitle)
    || left.title.localeCompare(right.title))) {
    const key = actionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length === MAX_ACTIONS) break;
  }
  return selected;
}

function summary(actions) {
  if (actions.length === 0) return 'There are no active course tasks to recommend right now. Explore the catalog or return when you are ready to learn.';
  if (actions[0].kind === 'PREPARE_ASSIGNMENT' || actions.some((item) => item.scheduledToday)) {
    return 'Here are the most timely steps from your recorded learning and saved plan.';
  }
  return 'Here are your next learning steps based on your recorded progress.';
}

function createLearningCoachService({ now = () => new Date() } = {}) {
  return {
    async get(studentId) {
      const student = objectId(studentId, 'studentId');
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new TypeError('now must return a valid Date');
      const context = await buildStudentContext(student, undefined, current);
      const tasks = currentTasks(context, current);
      const planned = await scheduledToday(student, context, tasks, current);
      const actions = selectActions([...planned, ...tasks]);
      return { message: summary(actions), actions };
    }
  };
}

module.exports = { createLearningCoachService, selectActions, currentTasks, dateKeyInZone };
