import { createFileRoute } from '@tanstack/react-router';
import { QuizPage } from '@/components/skillforge/assessment-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/quizzes/$courseId/$quizId')({head:()=>meta('Quiz','Answer multiple-choice questions with unlimited attempts and instant feedback.'),component:()=>{const p=Route.useParams();return <QuizPage courseId={p.courseId} quizId={p.quizId}/>;}});
