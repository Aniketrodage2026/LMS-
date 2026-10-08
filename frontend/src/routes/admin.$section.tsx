import { createFileRoute } from '@tanstack/react-router';
import { AdminPage } from '@/components/skillforge/admin-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/admin/$section')({head:({params})=>meta(`Admin · ${params.section}`,'SkillForge platform administration.'),component:()=><AdminPage section={Route.useParams().section}/>});
