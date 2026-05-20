import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { TopMenuBar } from "@/components/TopMenuBar";
import { ConfigBuilder } from "@/pages/ConfigBuilder";
import { BatchRunner } from "@/pages/BatchRunner";
import { JobDetail } from "@/pages/JobDetail";

const MIN_WIDTH = 1024;

export function App() {
  const { t } = useTranslation();
  const [tooSmall, setTooSmall] = useState(false);

  useEffect(() => {
    const onResize = () => setTooSmall(window.innerWidth < 640);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (tooSmall) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <h2 className="text-lg font-semibold">{t("mobile.title")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("mobile.body")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopMenuBar />
      <main className="mx-auto max-w-screen-2xl p-4" style={{ minWidth: 0 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/configs" replace />} />
          <Route path="/configs" element={<ConfigBuilder />} />
          <Route path="/configs/new" element={<ConfigBuilder />} />
          <Route path="/batch" element={<BatchRunner />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="*" element={<Navigate to="/configs" replace />} />
        </Routes>
      </main>
    </div>
  );
}
