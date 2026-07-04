import { useState } from "react";

import { NewBatchForm } from "@/features/batch-runner/NewBatchForm";
import { JobsList } from "@/features/batch-runner/JobsList";

export function BatchRunner() {
  const [bump, setBump] = useState(0);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  const handleJobCreated = (jobId: string) => {
    setBump((n) => n + 1);
    setHighlightJobId(jobId);
  };

  return (
    // 5.5rem = TopMenuBar h-14 (56px) + main p-4 top/bottom (32px)
    <div className="grid h-[calc(100dvh-5.5rem)] gap-3 lg:grid-cols-2">
      <NewBatchForm onJobCreated={handleJobCreated} />
      <JobsList refreshKey={bump} highlightJobId={highlightJobId} onClearHighlight={() => setHighlightJobId(null)} />
    </div>
  );
}
