import { createFileRoute } from '@tanstack/react-router';
import { AdminPage } from '@/components/skillforge/admin-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/admin/')({head:()=>meta('Platform administration','Manage roles and oversee the SkillForge platform.'),component:()=><AdminPage/>});
