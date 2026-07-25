import { Download } from 'lucide-react';
import { useState } from 'react';
import type { ArtifactDescriptor } from '../api/contracts';
import { downloadArtifact } from '../api/client';

export function ArtifactButton({ artifact }: { artifact: ArtifactDescriptor }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="artifact-action">
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void downloadArtifact(artifact.artifactId, artifact.fileName)
            .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <Download size={16} />{busy ? '下载中' : artifact.label}
      </button>
      {error && <small className="inline-error">{error}</small>}
    </div>
  );
}
