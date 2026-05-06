"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { he } from "@/lib/i18n/he";
import { useAppStore } from "@/lib/state/app-store";

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const { setFile, file, fileName, loadingState, setLoadingState, setAnalyzerData } = useAppStore();

  const onFileChange = (file: File | null) => {
    setError("");
    if (!file) {
      setFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".ifc")) {
      setError("ניתן לבחור רק קובץ IFC");
      return;
    }
    setFile(file);
    setLoadingState("ready");
  };

  const openModel = async () => {
    if (!file) return;
    setError("");
    setAnalyzing(true);
    setLoadingState("parsing");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/analyze-ifc", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Analyzer request failed");
      }
      const analyzerData = await response.json();
      setAnalyzerData(analyzerData);
      setLoadingState("ready");
      router.push("/viewer");
    } catch (err) {
      console.error("Analyzer failed:", err);
      setLoadingState("error");
      setError("ניתוח IFC נכשל. בדוק ש-Python ו-IfcOpenShell מותקנים.");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-4">
      <Card className="space-y-4">
        <h1 className="text-2xl font-bold">{he.appName}</h1>
        <h2 className="text-lg font-semibold">{he.uploadTitle}</h2>
        <p className="text-sm text-zinc-400">{he.uploadSubtitle}</p>
        <input
          type="file"
          accept=".ifc"
          className="w-full rounded-xl border border-dashed border-zinc-600 bg-zinc-950 p-4 text-sm"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
        <p className="text-sm text-zinc-300">{fileName || "לא נבחר קובץ"}</p>
        {loadingState !== "idle" && (
          <p className="text-xs text-zinc-400">
            {loadingState === "loading"
              ? he.loading
              : loadingState === "parsing"
                ? he.parsing
                : loadingState === "ready"
                  ? he.ready
                  : "שגיאה"}
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button
          size="lg"
          className="w-full"
          disabled={!fileName || analyzing}
          onClick={openModel}
        >
          {analyzing ? "מנתח מודל..." : he.openModel}
        </Button>
      </Card>
    </main>
  );
}
