import { createFileRoute } from '@tanstack/react-router';
import { CourseDetailPage } from '@/components/skillforge/public-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/courses/$courseId')({validateSearch:(s:Record<string,unknown>):{preview?:boolean}=>s['preview']===true||s['preview']==='true'?{preview:true}:{},head:()=>meta('Course details','See the curriculum, watch a free preview, and enroll on SkillForge.'),component:()=><CourseDetailPage id={Route.useParams().courseId} openPreview={Route.useSearch().preview}/>});
