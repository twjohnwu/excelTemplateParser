import { useState } from "react";

import { NewBatchForm } from "@/features/batch-runner/NewBatchForm";
import { JobsList } from "@/features/batch-runner/JobsList";

export function BatchRunner() {
  const [bump, setBump] = useState(0);
  return (
    <div className="grid h-[calc(100vh-160px)] gap-3 lg:grid-cols-2">
      <NewBatchForm onJobCreated={() => setBump((n) => n + 1)} />
      <JobsList refreshKey={bump} />
    </div>
  );
}
