import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '@/components/skillforge/public-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/courses/')({validateSearch:(s:Record<string,unknown>):{q?:string;free?:boolean}=>({...typeof s['q']==='string'?{q:s['q']}:{},...s['free']===true||s['free']==='true'?{free:true}:{}}),head:()=>meta('Explore courses','Find paid and completely free courses in development, design, and data science.'),component:Catalog});
function Catalog(){const {q,free}=Route.useSearch();return <CatalogPage q={q??''} free={free??false}/>;}
