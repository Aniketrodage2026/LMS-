import { createFileRoute } from '@tanstack/react-router';
import { ResetPage } from '@/components/skillforge/auth-pages';
import { meta } from '@/lib/skillforge/data';
import { authSearch } from '@/lib/auth-navigation';

export const Route = createFileRoute('/rest-password/$token')({
  validateSearch: authSearch,
  head: () => ({ ...meta('Reset password', 'Choose a new password for your SkillForge account.') }),
  component: () => <ResetPage token={Route.useParams().token} redirect={Route.useSearch().redirect} />,
});
