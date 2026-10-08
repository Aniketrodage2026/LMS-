import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/login')({validateSearch:(s:Record<string,unknown>):{redirect?:string}=>typeof s['redirect']==='string'?{redirect:s['redirect']}:{},head:()=>meta('Sign in','Sign in to SkillForge to continue your courses, assessments, and certificates.'),component:()=><LoginPage redirect={Route.useSearch().redirect}/>});
