import { JoinView } from '../../../components/JoinView.tsx';

export default async function Page({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <JoinView wsId={decodeURIComponent(ws)} />;
}
