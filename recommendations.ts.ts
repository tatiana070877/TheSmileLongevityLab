import type { DomainScoreRow, NitricOxideStrip } from "./obas";
import type { ReferralFlagDraft } from "./referrals";

export interface RecommendationDraft {
  priority: number;
  domainKey: string;
  recommendationText: string;
  duration?: string;
}

/**
 * Optional raw marker values passed in alongside domain scores.
 * When provided, marker-specific recommendations are generated first —
 * ensuring that an abnormal NO strip or acidic pH always surfaces,
 * even when inflammation dominates the domain ranking.
 */
export interface MarkerContext {
  salivaryPh?: number | null;
  noStrip?: NitricOxideStrip | null;
}

const POOL: Record<string, string[]> = {
  inflammation: [
    "Sonic brush 2× daily for 2 minutes at 45° to gingival margin.",
    "Interdental brush every evening in open embrasures.",
    "L. reuteri DSM 17938 / BLIS K12 lozenge daily after final brushing.",
    "If average pocket depth >3mm, schedule focused periodontal therapy (SRP) within 4 weeks.",
    "Repeat quantitative MMP-8 assessment at 6 weeks post-therapy.",
  ],
  oral_environment: [
    "Discontinue daily chlorhexidine/antiseptic mouthwash unless short-term prescribed indication.",
    "Daily nitrate-rich foods (rocket, spinach, beetroot) to support salivary NO pathway.",
    "Tongue scraping each morning before breakfast.",
    "Xylitol gum 3× daily for 10 minutes after meals.",
    "Reassess salivary pH and NO strip at 3 months.",
  ],
  oral_microbiome: [
    "Stop antiseptic mouthwash unless therapeutically indicated for ≤2 weeks.",
    "Nitrate-rich vegetables daily; maintain hydration.",
    "Tongue scraping each morning.",
    "Xylitol gum 3× daily.",
    "Microbiome-focused periodontal maintenance in 90 days.",
  ],
  dentition_longevity: [
    "Implant consultation for unreplaced posterior sites affecting function.",
    "CBCT bone volume assessment if ≥3 unreplaced sites in same quadrant.",
    "Night-time occlusal guard if parafunction suspected.",
    "Protect remaining natural teeth with risk-based recall (8–12 weeks).",
  ],
  structural_longevity: [
    "Hard acrylic occlusal splint for confirmed bruxism.",
    "Nano-hydroxyapatite paste nightly in high-wear zones.",
    "If severe erosion, GERD screening with physician co-management.",
    "Sleep and airway evaluation if STOP-BANG or symptoms escalate.",
  ],
  cancer_prevention: [
    "Monthly self-exam with mirror and bright light; photograph any change.",
    "Tobacco cessation reinforcement at every visit.",
    "Moderate alcohol; document units/week.",
    "VELscope recall or biopsy pathway per specialist instruction if suspicious.",
  ],
};

function pickFrom(domainKey: string, index: number): string {
  const list = POOL[domainKey] ?? POOL.inflammation;
  return list[index % list.length]!;
}

/**
 * Generate marker-specific recommendations for salivary pH (GC test)
 * and nitric oxide strip (Berkeley Biomedical strips).
 * These surface regardless of domain ranking so an abnormal individual
 * marker is never silently dropped.
 */
function markerSpecificRecs(ctx: MarkerContext): Array<{ domainKey: string; text: string; duration: string }> {
  const recs: Array<{ domainKey: string; text: string; duration: string }> = [];

  // ── Nitric Oxide strip (Berkeley Biomedical) ──────────────────────────
  if (ctx.noStrip === "white") {
    recs.push({
      domainKey: "oral_environment",
      text: "Berkeley NO strip: absent nitric oxide production. Stop all antiseptic mouthwash immediately. Add rocket, spinach, or beetroot daily to restore the oral nitrate–nitrite–NO pathway. Tongue scrape every morning before eating. Retest Berkeley strip at 4 weeks.",
      duration: "Start immediately",
    });
  } else if (ctx.noStrip === "light") {
    recs.push({
      domainKey: "oral_environment",
      text: "Berkeley NO strip: reduced nitric oxide. Discontinue daily antiseptic mouthwash. Increase dietary nitrates (rocket, spinach, beetroot) to 1 serving daily. Tongue scrape each morning. Recheck strip at 6–8 weeks.",
      duration: "4–8 week protocol",
    });
  }

  // ── Salivary pH — GC saliva-check pH test ────────────────────────────
  if (ctx.salivaryPh != null) {
    if (ctx.salivaryPh < 6.5) {
      recs.push({
        domainKey: "oral_environment",
        text: `GC saliva pH test: acidic environment (pH ${ctx.salivaryPh}). Apply GC Tooth Mousse (CPP-ACP) nightly after final brushing. Xylitol gum (≥1g xylitol) after every meal. Eliminate acidic drinks between meals. Retest GC pH strip at 3 months.`,
        duration: "90-day protocol",
      });
    } else if (ctx.salivaryPh >= 6.5 && ctx.salivaryPh < 6.7) {
      recs.push({
        domainKey: "oral_environment",
        text: `GC saliva pH test: borderline acidic (pH ${ctx.salivaryPh}). Xylitol gum 3× daily after meals. Reduce frequency of acidic foods and carbonated drinks. Reassess GC pH at 3 months.`,
        duration: "90-day protocol",
      });
    }
  }

  return recs;
}

export function generateRecommendations(
  domains: DomainScoreRow[],
  referrals: ReferralFlagDraft[],
  opts?: { activeSmoker?: boolean; markers?: MarkerContext },
): RecommendationDraft[] {
  const urgent = referrals.filter((r) => r.severity === "urgent");
  const sortedDomains = [...domains].sort((a, b) => a.score - b.score);

  const picks: RecommendationDraft[] = [];
  let p = 1;

  const add = (domainKey: string, text: string, duration?: string) => {
    if (picks.length >= 3) return;
    if (picks.some((x) => x.recommendationText === text)) return;
    picks.push({ priority: p++, domainKey, recommendationText: text, duration });
  };

  // 1. Smoker warning always first
  if (opts?.activeSmoker) {
    add(
      "inflammation",
      "Mandatory: structured tobacco cessation program; inflammation markers may underestimate true tissue burden while smoking.",
      "Start within 14 days",
    );
  }

  // 2. Urgent referrals
  for (const u of urgent) {
    if (picks.length >= 3) break;
    add(
      "cancer_prevention",
      `Priority referral: ${u.specialist} — ${u.reason}`,
      "Within 7 days",
    );
  }

  // 3. Marker-specific recommendations (NO strip + salivary pH)
  //    These run BEFORE domain ranking so they are never crowded out by
  //    inflammation dominating all three slots.
  if (opts?.markers) {
    for (const rec of markerSpecificRecs(opts.markers)) {
      add(rec.domainKey, rec.text, rec.duration);
    }
  }

  // 4. Domain-level recommendations for lowest-scoring domains
  let idx = 0;
  for (const d of sortedDomains) {
    if (picks.length >= 3) break;
    add(d.domainKey, pickFrom(d.domainKey, idx++), "90-day protocol");
  }

  // 5. Fill remaining slots from inflammation pool
  while (picks.length < 3) {
    add("inflammation", pickFrom("inflammation", idx++), "90-day protocol");
  }

  return picks.slice(0, 3);
}
