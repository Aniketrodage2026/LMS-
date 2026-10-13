import { createFileRoute } from '@tanstack/react-router';
import { RegisterPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
import { authSearch } from '@/lib/auth-navigation';
export const Route=createFileRoute('/register')({validateSearch:authSearch,head:()=>meta('Create your account','Create a free SkillForge student account and start learning today.'),component:()=><RegisterPage redirect={Route.useSearch().redirect}/>});
