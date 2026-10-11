import { DecisionView } from '../../../components/DecisionView.tsx';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DecisionView id={decodeURIComponent(id)} />;
}
