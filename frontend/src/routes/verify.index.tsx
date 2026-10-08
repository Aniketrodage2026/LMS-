import { createFileRoute } from '@tanstack/react-router';
import { VerificationPage } from '@/components/skillforge/student-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/verify/')({head:()=>meta('Verify a certificate','Check that a SkillForge certificate is genuine.'),component:()=><VerificationPage/>});
