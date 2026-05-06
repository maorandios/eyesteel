"use client";

export function InstallationPanel({ partCount = 0 }: { partCount?: number }) {
  return (
    <div className="space-y-2 text-sm text-zinc-300">
      <p>מצב הרכבה מציג אלמנט בהקשר סביבתי.</p>
      <p className="text-zinc-400">אלמנטים זמינים לניווט: {partCount}</p>
      <p className="text-zinc-400">השתמש בשכבות כדי להציג או להסתיר ברגים, עמודים וקורות.</p>
    </div>
  );
}
