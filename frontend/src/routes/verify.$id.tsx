import { createFileRoute } from '@tanstack/react-router';
import { VerificationPage } from '@/components/skillforge/student-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/verify/$id')({head:()=>meta('Certificate verification','Verify a SkillForge learner’s course completion certificate.'),component:()=><VerificationPage token={Route.useParams().id}/>});
