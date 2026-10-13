import { createFileRoute } from '@tanstack/react-router';
import { ForgotPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
import { authSearch } from '@/lib/auth-navigation';
export const Route=createFileRoute('/forgot-password')({validateSearch:authSearch,head:()=>meta('Forgot password','Request a secure link to reset your SkillForge password.'),component:()=><ForgotPage redirect={Route.useSearch().redirect}/>});
