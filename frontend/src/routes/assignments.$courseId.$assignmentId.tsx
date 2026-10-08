import { createFileRoute } from '@tanstack/react-router';
import { AssignmentPage } from '@/components/skillforge/assessment-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/assignments/$courseId/$assignmentId')({head:()=>meta('Assignment','Submit your work and review instructor feedback.'),component:()=>{const p=Route.useParams();return <AssignmentPage courseId={p.courseId} assignmentId={p.assignmentId}/>;}});
