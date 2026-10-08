import { createFileRoute } from '@tanstack/react-router';
import { HomePage } from '@/components/skillforge/public-pages';
import { meta } from '@/lib/skillforge/data';
export const Route = createFileRoute('/')({head:()=>meta('Learn skills that move your career forward','Build practical career-ready skills with expert-led recorded courses. Learn at your pace with SkillForge.'),component:HomePage});
