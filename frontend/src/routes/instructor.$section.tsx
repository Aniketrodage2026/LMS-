import { createFileRoute } from '@tanstack/react-router';
import { InstructorPage } from '@/components/skillforge/instructor-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/instructor/$section')({validateSearch:(s:Record<string,unknown>):{courseId?:string}=>typeof s['courseId']==='string'?{courseId:s['courseId']}:{},head:({params})=>meta(`Instructor · ${params.section}`,'Create courses, publish assessments, and give learners meaningful feedback.'),component:Instructor});
function Instructor(){const {section}=Route.useParams();const {courseId}=Route.useSearch();return <InstructorPage key={section+(courseId??'')} section={section} courseId={courseId}/>;}
