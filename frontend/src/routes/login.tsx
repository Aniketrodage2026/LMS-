import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
import { authSearch } from '@/lib/auth-navigation';
export const Route=createFileRoute('/login')({validateSearch:authSearch,head:()=>meta('Sign in','Sign in to SkillForge to continue your courses, assessments, and certificates.'),component:()=><LoginPage redirect={Route.useSearch().redirect}/>});
