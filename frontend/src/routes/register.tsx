import { createFileRoute } from '@tanstack/react-router';
import { RegisterPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/register')({head:()=>meta('Create your account','Create a free SkillForge student account and start learning today.'),component:RegisterPage});
