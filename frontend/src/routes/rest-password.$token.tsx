import { createFileRoute } from '@tanstack/react-router';
import { ResetPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';

export const Route = createFileRoute('/rest-password/$token')({
  head: () => ({ ...meta('Reset password', 'Choose a new password for your SkillForge account.') }),
  component: () => <ResetPage token={Route.useParams().token} />,
});
