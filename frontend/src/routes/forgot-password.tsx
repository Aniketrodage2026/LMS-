import { createFileRoute } from '@tanstack/react-router';
import { ForgotPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/forgot-password')({head:()=>meta('Forgot password','Request a secure link to reset your SkillForge password.'),component:ForgotPage});
