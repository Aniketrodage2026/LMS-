import { createFileRoute } from '@tanstack/react-router';
import { InstructorPage } from '@/components/skillforge/instructor-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/instructor/')({head:()=>meta('Instructor workspace','Create courses, publish assessments, and grade student work.'),component:()=><InstructorPage/>});
