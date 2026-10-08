import { createFileRoute } from '@tanstack/react-router';
import { RestrictedPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/restricted')({head:()=>meta('Access restricted','This SkillForge area is not available for your account.'),component:RestrictedPage});
