import web from '@/assets/web-development.jpg';
import design from '@/assets/design-foundations.jpg';
import python from '@/assets/python-data.jpg';
export type Course = { id:string; title:string; category:string; instructor:string; initials:string; level:string; lessons:number; duration:string; price:number; rating:number; reviews:number; image:string; tag?:string; description:string };
export const courses:Course[] = [
 {id:'full-stack',title:'Full-Stack Web Development',category:'Development',instructor:'Arjun Mehta',initials:'AM',level:'Beginner',lessons:64,duration:'32h 15m',price:2499,rating:4.9,reviews:1248,image:web,tag:'Bestseller',description:'Go from your first line of code to building and deploying production-ready web applications.'},
 {id:'ui-ux',title:'UI/UX Design Foundations',category:'Design',instructor:'Priya Sharma',initials:'PS',level:'Beginner',lessons:42,duration:'18h 30m',price:1499,rating:4.8,reviews:936,image:design,tag:'Popular',description:'Design thoughtful digital experiences with research, wireframes, and beautifully crafted interfaces.'},
 {id:'python',title:'Python for Data Analysis',category:'Data Science',instructor:'Rohan Kapoor',initials:'RK',level:'Intermediate',lessons:38,duration:'21h 45m',price:999,rating:4.9,reviews:782,image:python,tag:'Top rated',description:'Turn raw data into meaningful insights using Python, Pandas, and real-world datasets.'},
 {id:'react',title:'React Masterclass',category:'Development',instructor:'Arjun Mehta',initials:'AM',level:'Intermediate',lessons:48,duration:'24h 10m',price:1499,rating:4.9,reviews:654,image:web,description:'Build fast, accessible React applications with modern hooks, reusable patterns, and practical projects.'},
 {id:'design-thinking',title:'Design Thinking Essentials',category:'Design',instructor:'Priya Sharma',initials:'PS',level:'Beginner',lessons:12,duration:'3h 20m',price:0,rating:4.8,reviews:428,image:design,description:'Learn to ask better questions, uncover user needs, and solve meaningful problems.'},
 {id:'python-basics',title:'Getting Started with Python',category:'Data Science',instructor:'Rohan Kapoor',initials:'RK',level:'Beginner',lessons:16,duration:'4h 40m',price:0,rating:4.7,reviews:612,image:python,description:'A practical first step into programming. Build a strong foundation in Python at your own pace.'},
 {id:'web-basics',title:'HTML & CSS: The Essentials',category:'Development',instructor:'Neha Verma',initials:'NV',level:'Beginner',lessons:20,duration:'5h 15m',price:0,rating:4.8,reviews:523,image:web,description:'Create your first responsive website and learn the building blocks of the web.'},
];
export const categories=['All courses','Development','Design','Data Science','Business','Marketing'];
export const money=(price:number)=> price ? `₹${price.toLocaleString('en-IN')}` : 'Free';
export const lessons=['Welcome to the course','Setting up your workspace','Understanding the fundamentals','Your first practical project','Working with components','Building reusable patterns','Putting it all together','Final project & next steps'];
export const questions=[
 {text:'What is the primary purpose of a React component?',options:['Store database records','Create a reusable piece of the user interface','Configure the web server','Install dependencies'],correct:1,explanation:'Components encapsulate a reusable part of the interface and its behavior.'},
 {text:'Which hook manages local component state?',options:['useEffect','useContext','useState','useMemo'],correct:2,explanation:'useState adds state to a functional component and returns its value and setter.'},
 {text:'How should you update an array stored in React state?',options:['Mutate it directly','Create a new array and set it','Reload the page','Modify the DOM'],correct:1,explanation:'Immutable updates create a new reference so React can detect and render the change.'},
 {text:'Why do items in a rendered list need a stable key?',options:['To style the list','To identify items across renders','To sort alphabetically','To make the text bold'],correct:1,explanation:'Stable keys help React reconcile items when a list changes.'},
 {text:'What is a prop in React?',options:['A server endpoint','A CSS animation','Data passed into a component','A database table'],correct:2,explanation:'Props pass data from a parent into a child component.'},
];
export const QUIZ_PASS_MARK=80;
export function gradeQuiz(answers:number[]){const score=questions.reduce((n,q,i)=>n+(answers[i]===q.correct?1:0),0);const percentage=score/questions.length*100;return {score,percentage,passed:percentage>=QUIZ_PASS_MARK};}
export function certificateEligible(completion:number,quizzes:boolean[],assignments:boolean[],performance:number){return completion>=80 && quizzes.every(Boolean) && assignments.every(Boolean) && performance>=80;}
export function accessAction(price:number,enrolled:boolean){return enrolled?'Continue Learning':price===0?'Enroll Free':`Buy Course — ${money(price)}`;}
export function canAccessLesson(enrolled:boolean,lesson:number,preview:number|null=0){return enrolled || (preview!==null && lesson===preview);}
export function downloadText(filename:string,content:string,type='text/plain'){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}
export const meta=(title:string,description:string)=>({meta:[{title:`${title} — SkillForge`},{name:'description',content:description},{property:'og:title',content:`${title} — SkillForge`},{property:'og:description',content:description},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary_large_image'}]});
