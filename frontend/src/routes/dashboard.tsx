import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '@/components/skillforge/student-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/dashboard')({head:()=>meta('Your dashboard','Continue learning, track progress, and see your next steps on SkillForge.'),component:DashboardPage});
