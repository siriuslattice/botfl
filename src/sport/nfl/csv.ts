// Minimal RFC4180 CSV parsing — nflverse files quote fields containing commas
// (e.g. headshot URLs), so naive splitting is not an option. No dependency.

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export interface CsvTable {
  header: string[];
  col(name: string): number;
  /** For columns whose absence should degrade, not abort (-1 = missing; row[-1] is undefined). */
  colOpt(name: string): number;
}

export function csvHeader(firstLine: string): CsvTable {
  const header = parseCsvLine(firstLine.replace(/\r$/, ''));
  const index = new Map(header.map((h, i) => [h, i]));
  return {
    header,
    col(name: string): number {
      const i = index.get(name);
      if (i === undefined) throw new Error(`csv column missing: ${name}`);
      return i;
    },
    colOpt(name: string): number {
      return index.get(name) ?? -1;
    },
  };
}

/** Split CSV text into lines (handles CRLF; skips trailing empty line). */
export function csvLines(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.map((l) => l.replace(/\r$/, ''));
}
