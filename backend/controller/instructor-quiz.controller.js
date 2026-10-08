const mongoose = require('mongoose');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const AppError = require('../utils/appError');

const draftUpdateFields = new Set(['title', 'instructions', 'passMark', 'questions', 'status']);

function validObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function authorQuiz(quiz) {
  return {
    id: String(quiz._id),
    course: String(quiz.course),
    title: quiz.title,
    instructions: quiz.instructions,
    passMark: quiz.passMark,
    status: quiz.status,
    questions: quiz.questions.map((question) => ({
      id: String(question._id),
      prompt: question.prompt,
      options: question.options,
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation
    }))
  };
}

function validationError(error) {
  if (error instanceof AppError) return error;
  return new AppError(error.message, error.name === 'ValidationError' ? 400 : 500);
}

function draftUpdates(body) {
  const keys = Object.keys(body || {});
  const unexpected = keys.find((key) => !draftUpdateFields.has(key));
  if (unexpected) throw new AppError(`Unsupported quiz field: ${unexpected}`, 400);
  return Object.fromEntries(keys.map((key) => [key, body[key]]));
}

function statusOnlyUpdate(body) {
  const keys = Object.keys(body || {});
  return keys.length === 1
    && keys[0] === 'status'
    && ['DRAFT', 'PUBLISHED'].includes(body.status);
}

async function findManagedQuiz(req) {
  const { quizId } = req.params;
  if (!validObjectId(quizId)) throw new AppError('Invalid quizId format', 400);
  const quiz = await Quiz.findOne({ _id: quizId, course: req.course._id });
  if (!quiz) throw new AppError('Quiz not found', 404);
  return quiz;
}

async function quizHasAttempts(quizId) {
  return Boolean(await QuizAttempt.exists({ quiz: quizId }));
}

async function isAttemptedQuiz(quiz) {
  return quiz.attemptCount > 0 || quizHasAttempts(quiz._id);
}

async function conditionalMutationFailure(req, quizId) {
  const current = await Quiz.findOne({ _id: quizId, course: req.course._id });
  if (!current) throw new AppError('Quiz not found', 404);
  if (await isAttemptedQuiz(current)) {
    throw new AppError('Attempted quizzes can only change status', 409);
  }
  throw new AppError('Quiz was modified before it could be updated', 409);
}

exports.createQuiz = async (req, res, next) => {
  try {
    const { title, instructions, passMark, questions } = req.body;
    const quiz = await Quiz.create({
      course: req.course._id,
      title,
      instructions,
      passMark,
      questions,
      status: 'DRAFT'
    });
    return res.status(201).json({ success: true, quiz: authorQuiz(quiz) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.listInstructorQuizzes = async (req, res, next) => {
  try {
    const quizzes = await Quiz.find({ course: req.course._id }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, quizzes: quizzes.map(authorQuiz) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.updateQuiz = async (req, res, next) => {
  try {
    const quiz = await findManagedQuiz(req);
    if (statusOnlyUpdate(req.body)) {
      const updatedQuiz = await Quiz.findOneAndUpdate(
        { _id: quiz._id, course: req.course._id },
        { $set: { status: req.body.status } },
        { new: true, runValidators: true }
      );
      if (!updatedQuiz) throw new AppError('Quiz not found', 404);
      return res.status(200).json({ success: true, quiz: authorQuiz(updatedQuiz) });
    }

    if (await isAttemptedQuiz(quiz)) {
      return next(new AppError('Attempted quizzes can only change status', 409));
    }

    const updates = draftUpdates(req.body);
    if (Object.keys(updates).length === 0) {
      return next(new AppError('At least one quiz field is required', 400));
    }

    const candidate = new Quiz({ ...quiz.toObject(), ...updates });
    await candidate.validate();
    const updatedQuiz = await Quiz.findOneAndUpdate(
      { _id: quiz._id, course: req.course._id, attemptCount: 0 },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updatedQuiz) await conditionalMutationFailure(req, quiz._id);
    return res.status(200).json({ success: true, quiz: authorQuiz(updatedQuiz) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.deleteQuiz = async (req, res, next) => {
  try {
    const quiz = await findManagedQuiz(req);
    if (await isAttemptedQuiz(quiz)) {
      return next(new AppError('Attempted quizzes cannot be deleted', 409));
    }
    const deletedQuiz = await Quiz.findOneAndDelete({
      _id: quiz._id,
      course: req.course._id,
      attemptCount: 0
    });
    if (!deletedQuiz) await conditionalMutationFailure(req, quiz._id);
    return res.status(200).json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    return next(validationError(error));
  }
};
