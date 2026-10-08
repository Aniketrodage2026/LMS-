import {describe,it,expect} from 'vitest';
import {accessAction,canAccessLesson,certificateEligible,gradeQuiz,questions,money} from '@/lib/skillforge/data';
describe('Course access rules',()=>{
 it('labels completely free courses for free enrollment',()=>expect(accessAction(0,false)).toBe('Enroll Free'));
 it('offers an INR one-time purchase for a paid course',()=>expect(accessAction(1499,false)).toBe('Buy Course — ₹1,499'));
 it('lets enrolled learners continue',()=>expect(accessAction(1499,true)).toBe('Continue Learning'));
 it('locks unpurchased lessons except the single chosen preview',()=>{expect(canAccessLesson(false,0,0)).toBe(true);expect(canAccessLesson(false,1,0)).toBe(false);expect(canAccessLesson(false,0,null)).toBe(false);});
 it('allows enrolled access to all lessons',()=>expect(canAccessLesson(true,4)).toBe(true));
 it('formats INR prices',()=>{expect(money(999)).toBe('₹999');expect(money(2499)).toBe('₹2,499');});
});
describe('Assessment and certificate requirements',()=>{
 it('grades immediately with a concrete 80% quiz pass mark',()=>{const a=questions.map(q=>q.correct);a[0]=0;expect(gradeQuiz(a)).toEqual({score:4,percentage:80,passed:true});a[1]=0;expect(gradeQuiz(a).passed).toBe(false);});
 it('requires at least 80% course completion',()=>{expect(certificateEligible(79,[true],[true],90)).toBe(false);expect(certificateEligible(80,[true],[true],90)).toBe(true);});
 it('requires passing every published quiz',()=>{expect(certificateEligible(100,[true,false],[true],90)).toBe(false);expect(certificateEligible(100,[true,true],[true],90)).toBe(true);});
 it('requires passing every published assignment',()=>{expect(certificateEligible(100,[true],[true,false],90)).toBe(false);expect(certificateEligible(100,[true],[true,true],90)).toBe(true);});
 it('requires at least 80% overall assessment performance',()=>{expect(certificateEligible(100,[true],[true],79)).toBe(false);expect(certificateEligible(100,[true],[true],80)).toBe(true);});
});
