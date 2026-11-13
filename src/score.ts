// Score an agent's answers for keys 8..13 against expected answers (test/fixtures/expected.json).
// Bar: 18 of 20 contracts fully right and no miss on mint (key 9) or upgrade (key 8).
export interface Score { contracts: number; fullyRight: number; criticalMisses: string[]; wrong: { contract: string; key: number; got: string; want: string }[]; pass: boolean }

export function scoreAgent(got: Record<string, Record<string, string>>, expected: Record<string, Record<string, string>>): Score {
  let fully = 0; const wrong: Score["wrong"] = []; const crit: string[] = [];
  const names = Object.keys(expected);
  for (const c of names) {
    let ok = true;
    for (let k = 8; k <= 13; k++) {
      const want = expected[c]![String(k)]!, g = got[c]?.[String(k)] ?? "UNKNOWN";
      if (g !== want) { ok = false; wrong.push({ contract: c, key: k, got: g, want }); if ((k === 8 || k === 9) && g !== "UNKNOWN") crit.push(`${c} key ${k}`); }
      else continue;
      if ((k === 8 || k === 9) && g === "UNKNOWN") crit.push(`${c} key ${k} (UNKNOWN)`);
    }
    if (ok) fully++;
  }
  return { contracts: names.length, fullyRight: fully, criticalMisses: crit, wrong, pass: fully >= Math.ceil(names.length * 0.9) && crit.length === 0 };
}
