import { WorkspaceView } from '../../../components/WorkspaceView.tsx';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkspaceView id={decodeURIComponent(id)} />;
}
