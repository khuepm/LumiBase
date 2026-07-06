import { useQuery } from '@tanstack/react-query';
import type { FieldResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

export function TranslatableText({
  value,
  onChange,
}: {
  field: FieldResource;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const client = getApiClient();

  const settingsQuery = useQuery({
    queryKey: ['settings', 'locales'],
    queryFn: async () => {
      try {
        const res = await client.settings.get('locales');
        return res.data;
      } catch {
        return null; // Might not exist yet
      }
    },
  });

  const supportedLangs = (settingsQuery.data?.value?.supported as string[]) ?? ['en', 'vi'];
  
  // The value is expected to be a Record<string, string> (e.g. { en: "Hello", vi: "Xin chào" })
  const map = (typeof value === 'object' && value !== null ? value : {}) as Record<string, string>;

  const updateLocale = (lang: string, val: string) => {
    onChange({ ...map, [lang]: val });
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/10 p-3">
      {supportedLangs.map((lang) => (
        <div key={lang} className="flex gap-2">
          <div className="flex h-9 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-xs font-medium uppercase text-muted-foreground">
            {lang}
          </div>
          <input
            type="text"
            value={map[lang] ?? ''}
            onChange={(e) => updateLocale(lang, e.target.value)}
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
            placeholder={`Translation for ${lang.toUpperCase()}...`}
          />
        </div>
      ))}
    </div>
  );
}
