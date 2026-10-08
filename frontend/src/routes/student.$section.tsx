import { createFileRoute } from '@tanstack/react-router';
import { StudentPage } from '@/components/skillforge/student-pages';
import { meta } from '@/lib/skillforge/data';
export const Route=createFileRoute('/student/$section')({head:({params})=>meta(({'my-learning':'My Learning',purchases:'Purchases',assessments:'Assessments',certificates:'Certificates',profile:'Your profile'} as Record<string,string>)[params.section]??'Student workspace','Track your courses, purchases, assessments, and achievements.'),component:()=><StudentPage section={Route.useParams().section}/>});
