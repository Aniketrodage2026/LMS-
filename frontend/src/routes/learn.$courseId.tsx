import { createFileRoute } from '@tanstack/react-router';
import { PlayerPage } from '@/components/skillforge/assessment-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/learn/$courseId')({validateSearch:(s:Record<string,unknown>):{lecture?:string}=>typeof s['lecture']==='string'?{lecture:s['lecture']}:{},head:()=>meta('Learning player','Watch lessons, save progress automatically, and mark lessons complete.'),component:()=><PlayerPage id={Route.useParams().courseId} lecture={Route.useSearch().lecture}/>});
